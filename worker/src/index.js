/**
 * Biggs API (Cloudflare Worker). Endpoints:
 *   POST /api/subscribe     sign-up form   -> pending subscriber + confirmation email
 *   POST /api/confirm       email link     -> confirmed subscriber
 *   POST /api/unsubscribe   email link     -> unsubscribed
 *   GET  /api/content       public page content (cached at the edge for a minute)
 *   GET  /api/img/:id       page images (cached for a year, ids never change)
 *
 * Browsers can never write to Firestore. Only this Worker can, through a service account.
 * Layers on the sign-up path: origin allow-list, body size cap, honeypot, minimum fill time,
 * per-person and overall rate limits, Cloudflare Turnstile, strict email validation,
 * disposable-domain block, double opt-in, and one generic reply whatever happens to an address.
 */

import { Firestore, FirestoreConflict } from './firestore.js';
import * as v from './validate.js';

export { Limiter } from './limiter.js';

const GAP_MS = 10 * 60 * 1000; // do not re-send a confirmation email more often than this
const TOKEN_MS = 48 * 60 * 60 * 1000;
const MIN_FILL_MS = 1500;
const CONFIRM_PER_HOUR = 30;

const json = (status, body, extra = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...extra },
  });

const num = (value, fallback) => (Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : fallback);

// ------------------------------------------------------------------ helpers
/** Checks origin, method, type and size. Returns { body, cors } or { res } when already answered. */
async function readPost(request, env) {
  const origin = request.headers.get('Origin');
  const allowed = (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const cors = {};
  if (origin) {
    if (!allowed.includes(origin)) return { res: json(403, { ok: false, error: 'origin' }) };
    cors['Access-Control-Allow-Origin'] = origin;
    cors.Vary = 'Origin';
  }
  if (request.method === 'OPTIONS') {
    return {
      res: new Response(null, {
        status: 204,
        headers: { ...cors, 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '600' },
      }),
    };
  }
  if (request.method !== 'POST') return { res: json(405, { ok: false, error: 'method' }, { Allow: 'POST' }) };
  if (!(request.headers.get('Content-Type') || '').includes('application/json')) return { res: json(415, { ok: false, error: 'type' }, cors) };
  const text = await request.text();
  if (text.length > 4096) return { res: json(413, { ok: false, error: 'size' }, cors) };
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return { res: json(400, { ok: false, error: 'body' }, cors) };
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { res: json(400, { ok: false, error: 'body' }, cors) };
  return { body, cors };
}

/** Counts a hit in the limiter. Returns false once the limit for the window is passed. */
async function hit(env, key, limit, windowSec) {
  const stub = env.LIMITER.get(env.LIMITER.idFromName('limiter'));
  const res = await stub.fetch('https://limiter/hit', { method: 'POST', body: JSON.stringify({ key, limit, windowSec }) });
  return (await res.json()).ok === true;
}

async function ipKey(request, env, prefix) {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  return `${prefix}_${(await v.hmacHex(env.HMAC_SECRET, 'ip:' + ip)).slice(0, 32)}`;
}

async function verifyTurnstile(token, request, env) {
  if (typeof token !== 'string' || token.length < 10 || token.length > 2048) return false;
  const body = new URLSearchParams({ secret: env.TURNSTILE_SECRET, response: token });
  const ip = request.headers.get('CF-Connecting-IP');
  if (ip) body.set('remoteip', ip);
  try {
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body });
    return (await res.json()).success === true;
  } catch (err) {
    console.error('turnstile verify failed', err);
    return false; // fail closed
  }
}

async function sendConfirmation(env, email, id, token) {
  const base = (env.SITE_URL || '').replace(/\/+$/, '');
  const link = `${base}/confirm.html?id=${id}&t=${token}`;
  const html =
    '<div style="font-family:Arial,sans-serif;max-width:480px;color:#243026">' +
    '<h2>Confirm your email</h2><p>Thanks for signing up to hear about new Biggs cookies.</p>' +
    `<p><a href="${link}" style="background:#d7a535;color:#243026;padding:12px 20px;border-radius:999px;text-decoration:none;font-weight:bold;display:inline-block">Yes, add me to the list</a></p>` +
    '<p style="font-size:13px;color:#666">If you did not sign up, ignore this email and nothing happens. The link works for 48 hours.</p></div>';
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: env.FROM_EMAIL, to: [email], subject: 'Confirm your email for Biggs cookies', html }),
  });
  if (!res.ok) throw new Error(`Resend responded ${res.status}`);
}

// ------------------------------------------------------------------ handlers
async function subscribe(request, env) {
  const { body, cors, res } = await readPost(request, env);
  if (res) return res;
  const reply = (status, obj) => json(status, obj, cors);
  const ok = () => reply(200, { ok: true }); // identical whatever happened to the address

  // Cheap bot traps first: act as if it worked, store nothing.
  if (typeof body.hp === 'string' && body.hp.length > 0) return ok();
  if (typeof body.elapsed !== 'number' || body.elapsed < MIN_FILL_MS) return ok();

  // Limits before any external or paid work. Blocked attempts never reach Firestore.
  const personKey = await ipKey(request, env, 'ip');
  if (!(await hit(env, personKey, num(env.IP_PER_HOUR, 5), 3600))) return reply(429, { ok: false, error: 'rate_limited' });
  if (!(await hit(env, 'global', num(env.GLOBAL_PER_HOUR, 300), 3600))) return reply(429, { ok: false, error: 'rate_limited' });

  if (!(await verifyTurnstile(body.token, request, env))) return reply(400, { ok: false, error: 'bot_check' });

  const email = v.normaliseEmail(body.email);
  if (!email || !v.isValidEmail(email) || v.isDisposable(email)) return reply(400, { ok: false, error: 'invalid_email' });

  const id = await v.sha256Hex(email);
  const fs = new Firestore(env);
  const existing = await fs.get(`subscribers/${id}`);
  const now = Date.now();
  if (existing) {
    const d = existing.data;
    if (d.status === 'confirmed') return ok(); // already on the list, say nothing
    if (d.status === 'pending' && d.lastEmailAt && now - d.lastEmailAt.getTime() < GAP_MS) return ok();
  }

  const token = v.newToken();
  const record = {
    email,
    status: 'pending',
    source: v.cleanText(body.source, 40) || 'unknown',
    consentText: v.cleanText(body.consent, 300),
    createdAt: existing && existing.data.createdAt ? existing.data.createdAt : new Date(now),
    tokenHash: await v.sha256Hex(token),
    tokenExpires: new Date(now + TOKEN_MS),
    lastEmailAt: new Date(now),
    ipHash: personKey,
    unsubSig: await v.hmacHex(env.HMAC_SECRET, 'unsub:' + id),
  };

  try {
    if (existing) await fs.write(`subscribers/${id}`, record, { updateTime: existing.updateTime });
    else await fs.create('subscribers', id, record);
  } catch (err) {
    if (err instanceof FirestoreConflict) return ok(); // someone else just wrote it: treat as a duplicate
    throw err;
  }

  try {
    await sendConfirmation(env, email, id, token);
  } catch (err) {
    console.error('confirmation email failed', err);
    return reply(502, { ok: false, error: 'email_failed' });
  }
  return ok();
}

async function confirm(request, env) {
  const { body, cors, res } = await readPost(request, env);
  if (res) return res;
  const reply = (status, obj) => json(status, obj, cors);
  const { id, token } = body;
  if (!v.isDocId(id) || !v.isToken(token)) return reply(400, { ok: false, error: 'invalid_link' });
  if (!(await hit(env, await ipKey(request, env, 'cf'), CONFIRM_PER_HOUR, 3600))) return reply(429, { ok: false, error: 'rate_limited' });

  const fs = new Firestore(env);
  const doc = await fs.get(`subscribers/${id}`);
  if (!doc) return reply(400, { ok: false, error: 'invalid_link' });
  const d = doc.data;
  if (d.status === 'confirmed') return reply(200, { ok: true });
  if (d.status !== 'pending' || !d.tokenHash) return reply(400, { ok: false, error: 'invalid_link' });
  if (!d.tokenExpires || d.tokenExpires.getTime() < Date.now()) return reply(400, { ok: false, error: 'expired' });
  if (!v.safeEqualHex(await v.sha256Hex(token), d.tokenHash)) return reply(400, { ok: false, error: 'invalid_link' });

  try {
    // tokenHash and tokenExpires are in the mask but not in the data, so they are removed.
    await fs.write(`subscribers/${id}`, { status: 'confirmed', confirmedAt: new Date() }, {
      updateTime: doc.updateTime,
      mask: ['status', 'confirmedAt', 'tokenHash', 'tokenExpires'],
    });
  } catch (err) {
    if (!(err instanceof FirestoreConflict)) throw err; // a double click: already handled
  }
  return reply(200, { ok: true });
}

async function unsubscribe(request, env) {
  const { body, cors, res } = await readPost(request, env);
  if (res) return res;
  const reply = (status, obj) => json(status, obj, cors);
  const { id, sig } = body;
  if (!v.isDocId(id) || typeof sig !== 'string') return reply(400, { ok: false, error: 'invalid_link' });
  if (!v.safeEqualHex(sig, await v.hmacHex(env.HMAC_SECRET, 'unsub:' + id))) return reply(400, { ok: false, error: 'invalid_link' });
  if (!(await hit(env, await ipKey(request, env, 'un'), CONFIRM_PER_HOUR, 3600))) return reply(429, { ok: false, error: 'rate_limited' });

  const fs = new Firestore(env);
  const doc = await fs.get(`subscribers/${id}`);
  if (doc && doc.data.status !== 'unsubscribed') {
    try {
      await fs.write(`subscribers/${id}`, { status: 'unsubscribed', unsubscribedAt: new Date() }, {
        updateTime: doc.updateTime,
        mask: ['status', 'unsubscribedAt'],
      });
    } catch (err) {
      if (!(err instanceof FirestoreConflict)) throw err;
    }
  }
  return reply(200, { ok: true });
}

const edgeCache = () => (typeof caches !== 'undefined' ? caches.default : null);

async function content(request, env, ctx) {
  const cache = edgeCache();
  const hitResponse = cache && (await cache.match(request));
  if (hitResponse) return hitResponse;

  const doc = await new Firestore(env).get('site/holding');
  const out = {};
  if (doc) for (const [k, val] of Object.entries(doc.data)) if (typeof val === 'string') out[k] = val;
  const res = new Response(JSON.stringify({ content: out }), {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=30, s-maxage=60',
      'Access-Control-Allow-Origin': '*',
      'X-Content-Type-Options': 'nosniff',
    },
  });
  if (cache) ctx.waitUntil(cache.put(request, res.clone()));
  return res;
}

async function image(request, env, ctx, id) {
  if (!v.isImageId(id)) return json(404, { ok: false, error: 'not_found' });
  const cache = edgeCache();
  const hitResponse = cache && (await cache.match(request));
  if (hitResponse) return hitResponse;

  const doc = await new Firestore(env).get(`images/${id}`);
  if (!doc || !['image/webp', 'image/jpeg'].includes(doc.data.mime) || typeof doc.data.b64 !== 'string') {
    return json(404, { ok: false, error: 'not_found' });
  }
  let bytes;
  try {
    bytes = Uint8Array.from(atob(doc.data.b64), (c) => c.charCodeAt(0));
  } catch {
    return json(404, { ok: false, error: 'not_found' });
  }
  const res = new Response(bytes, {
    headers: {
      'Content-Type': doc.data.mime,
      'Cache-Control': 'public, max-age=31536000, immutable',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'Cross-Origin-Resource-Policy': 'cross-origin',
    },
  });
  if (cache) ctx.waitUntil(cache.put(request, res.clone()));
  return res;
}

// ------------------------------------------------------------------ router
export default {
  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);
    try {
      if (pathname === '/api/subscribe') return await subscribe(request, env);
      if (pathname === '/api/confirm') return await confirm(request, env);
      if (pathname === '/api/unsubscribe') return await unsubscribe(request, env);
      if (request.method === 'GET' && pathname === '/api/content') return await content(request, env, ctx);
      if (request.method === 'GET' && pathname.startsWith('/api/img/')) return await image(request, env, ctx, pathname.slice(9));
      return json(404, { ok: false, error: 'not_found' });
    } catch (err) {
      console.error('request failed', err);
      return json(500, { ok: false, error: 'server' });
    }
  },
};
