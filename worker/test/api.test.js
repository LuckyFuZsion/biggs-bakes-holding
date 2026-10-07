import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { Limiter } from '../src/index.js';
import { decodeFields } from '../src/firestore.js';

const ORIGIN = 'https://biggsbakes.com';

// ---------------------------------------------------------------- fakes
const docs = new Map(); // "subscribers/abc" -> { fields, updateTime }
const emails = [];
let clock = 1;

function fakeLimiterNamespace() {
  const store = new Map();
  const state = {
    storage: {
      get: async (k) => store.get(k),
      put: async (k, val) => void store.set(k, val),
      delete: async (k) => void store.delete(k),
      list: async () => new Map(store),
    },
  };
  const limiter = new Limiter(state);
  return { idFromName: (n) => n, get: () => ({ fetch: (url, init) => limiter.fetch(new Request(url, init)) }) };
}

function fakeFirestore(url, init) {
  const u = new URL(url);
  const root = '/v1/projects/p/databases/(default)/documents/';
  const path = decodeURIComponent(u.pathname.slice(root.length));
  const body = init.body ? JSON.parse(init.body) : null;
  const reply = (status, obj) => new Response(JSON.stringify(obj || {}), { status });
  const stamp = () => `2026-01-01T00:00:${String(clock++).padStart(2, '0')}Z`;

  if (init.method === 'GET') {
    const d = docs.get(path);
    return d ? reply(200, { fields: d.fields, updateTime: d.updateTime }) : reply(404);
  }
  if (init.method === 'POST') {
    const full = `${path}/${u.searchParams.get('documentId')}`;
    if (docs.has(full)) return reply(409);
    docs.set(full, { fields: body.fields, updateTime: stamp() });
    return reply(200, {});
  }
  if (init.method === 'PATCH') {
    const d = docs.get(path);
    const pre = u.searchParams.get('currentDocument.updateTime');
    if (pre && (!d || d.updateTime !== pre)) return reply(409);
    const mask = u.searchParams.getAll('updateMask.fieldPaths');
    if (mask.length && d) {
      const fields = { ...d.fields };
      for (const m of mask) delete fields[m];
      Object.assign(fields, body.fields);
      docs.set(path, { fields, updateTime: stamp() });
    } else {
      docs.set(path, { fields: body.fields, updateTime: stamp() });
    }
    return reply(200, {});
  }
  return reply(405);
}

const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  const href = String(url);
  if (href.startsWith('https://challenges.cloudflare.com')) {
    return Response.json({ success: String(init.body).includes('response=good-token') });
  }
  if (href.startsWith('https://api.resend.com')) {
    emails.push(JSON.parse(init.body));
    return Response.json({ id: 'e1' });
  }
  if (href.startsWith('https://oauth2.googleapis.com')) return Response.json({ access_token: 'tok', expires_in: 3600 });
  if (href.startsWith('https://firestore.googleapis.com')) return fakeFirestore(href, init);
  return realFetch(url, init);
};

async function makeEnv() {
  const pair = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify']
  );
  const pkcs8 = Buffer.from(await crypto.subtle.exportKey('pkcs8', pair.privateKey)).toString('base64');
  return {
    ALLOWED_ORIGINS: `${ORIGIN},https://www.biggsbakes.com`,
    SITE_URL: ORIGIN,
    FROM_EMAIL: 'Biggs <hello@biggsbakes.com>',
    FIREBASE_PROJECT_ID: 'p',
    IP_PER_HOUR: '5',
    GLOBAL_PER_HOUR: '300',
    TURNSTILE_SECRET: 's',
    RESEND_API_KEY: 'r',
    HMAC_SECRET: 'hmac-secret-for-tests',
    FIREBASE_SERVICE_ACCOUNT: JSON.stringify({
      client_email: 'x@p.iam.gserviceaccount.com',
      private_key: `-----BEGIN PRIVATE KEY-----\n${pkcs8}\n-----END PRIVATE KEY-----\n`,
    }),
    LIMITER: fakeLimiterNamespace(),
  };
}

const ctx = { waitUntil() {} };
const post = (path, body, { origin = ORIGIN, ip = '203.0.113.5' } = {}) =>
  new Request(`https://api.test${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip, ...(origin ? { Origin: origin } : {}) },
    body: JSON.stringify(body),
  });
const signUp = (email, extra = {}) => ({ email, token: 'good-token', hp: '', elapsed: 5000, source: 'test', consent: 'I agree', ...extra });
const call = async (env, request) => {
  const res = await worker.fetch(request, env, ctx);
  return { status: res.status, body: await res.json().catch(() => null), res };
};

test.beforeEach(() => {
  docs.clear();
  emails.length = 0;
});

// ---------------------------------------------------------------- tests
test('sign up, confirm by email link, then a repeat sign up is silent', async () => {
  const env = await makeEnv();
  const r1 = await call(env, post('/api/subscribe', signUp('Jane@Gmail.com')));
  assert.deepEqual([r1.status, r1.body], [200, { ok: true }]);
  assert.equal(emails.length, 1);
  assert.deepEqual(emails[0].to, ['jane@gmail.com']);

  const link = new URL(/href="([^"]+)"/.exec(emails[0].html)[1]);
  const id = link.searchParams.get('id');
  const token = link.searchParams.get('t');
  assert.equal(decodeFields(docs.get(`subscribers/${id}`).fields).status, 'pending');

  const wrong = await call(env, post('/api/confirm', { id, token: 'A'.repeat(43) }));
  assert.equal(wrong.body.error, 'invalid_link');

  const good = await call(env, post('/api/confirm', { id, token }));
  assert.equal(good.body.ok, true);
  const saved = decodeFields(docs.get(`subscribers/${id}`).fields);
  assert.equal(saved.status, 'confirmed');
  assert.equal(saved.tokenHash, undefined, 'token is removed once used');
  assert.equal(saved.email, 'jane@gmail.com');

  const again = await call(env, post('/api/subscribe', signUp('jane@gmail.com'), { ip: '203.0.113.6' }));
  assert.equal(again.status, 200);
  assert.equal(emails.length, 1, 'no second email for someone already confirmed');
});

test('honeypot and instant submissions look successful but store nothing', async () => {
  const env = await makeEnv();
  assert.equal((await call(env, post('/api/subscribe', signUp('a@gmail.com', { hp: 'x' })))).status, 200);
  assert.equal((await call(env, post('/api/subscribe', signUp('b@gmail.com', { elapsed: 200 })))).status, 200);
  assert.equal(docs.size, 0);
  assert.equal(emails.length, 0);
});

test('failed bot check, bad email and disposable email are refused', async () => {
  const env = await makeEnv();
  assert.equal((await call(env, post('/api/subscribe', signUp('a@gmail.com', { token: 'bad-token-value' })))).body.error, 'bot_check');
  assert.equal((await call(env, post('/api/subscribe', signUp('not-an-email')))).body.error, 'invalid_email');
  assert.equal((await call(env, post('/api/subscribe', signUp('x@mailinator.com')))).body.error, 'invalid_email');
  assert.equal(docs.size, 0);
});

test('the sixth attempt from one person in an hour is rate limited before anything is stored', async () => {
  const env = await makeEnv();
  for (let i = 0; i < 5; i++) {
    assert.equal((await call(env, post('/api/subscribe', signUp(`user${i}@gmail.com`), { ip: '198.51.100.9' }))).status, 200);
  }
  const blocked = await call(env, post('/api/subscribe', signUp('user9@gmail.com'), { ip: '198.51.100.9' }));
  assert.equal(blocked.status, 429);
  assert.equal(docs.size, 5);
});

test('requests from other websites, wrong methods and oversized bodies are refused', async () => {
  const env = await makeEnv();
  assert.equal((await call(env, post('/api/subscribe', signUp('a@gmail.com'), { origin: 'https://evil.example' }))).status, 403);
  assert.equal((await call(env, new Request('https://api.test/api/subscribe', { method: 'GET' }))).status, 405);
  const huge = new Request('https://api.test/api/subscribe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'a@gmail.com', junk: 'x'.repeat(5000) }),
  });
  assert.equal((await call(env, huge)).status, 413);
  const notJson = new Request('https://api.test/api/subscribe', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: 'x' });
  assert.equal((await call(env, notJson)).status, 415);
});

test('unsubscribe needs the personal signature', async () => {
  const env = await makeEnv();
  await call(env, post('/api/subscribe', signUp('jane@gmail.com')));
  const id = [...docs.keys()][0].split('/')[1];
  const { unsubSig } = decodeFields(docs.get(`subscribers/${id}`).fields);

  assert.equal((await call(env, post('/api/unsubscribe', { id, sig: 'a'.repeat(64) }))).body.error, 'invalid_link');
  assert.equal(decodeFields(docs.get(`subscribers/${id}`).fields).status, 'pending');
  assert.equal((await call(env, post('/api/unsubscribe', { id, sig: unsubSig }))).body.ok, true);
  assert.equal(decodeFields(docs.get(`subscribers/${id}`).fields).status, 'unsubscribed');
});

test('public content only exposes text fields and images are served safely', async () => {
  const env = await makeEnv();
  docs.set('site/holding', {
    updateTime: 't',
    fields: { heading: { stringValue: 'Hi' }, updatedAt: { timestampValue: '2026-01-01T00:00:00Z' } },
  });
  const c = await call(env, new Request('https://api.test/api/content'));
  assert.deepEqual(c.body, { content: { heading: 'Hi' } });

  docs.set('images/logo-1712345678901', { updateTime: 't', fields: { mime: { stringValue: 'image/webp' }, b64: { stringValue: Buffer.from('RIFFxxxx').toString('base64') } } });
  const ok = await worker.fetch(new Request('https://api.test/api/img/logo-1712345678901'), env, ctx);
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('Content-Type'), 'image/webp');
  assert.equal(ok.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.equal((await call(env, new Request('https://api.test/api/img/..%2Fsecret'))).status, 404);
  assert.equal((await call(env, new Request('https://api.test/api/img/logo-1999999999999'))).status, 404);
});
