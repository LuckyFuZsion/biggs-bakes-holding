import { base64url } from './validate.js';

/**
 * Minimal Firestore REST client. The Worker signs in as a dedicated service account (role: Cloud
 * Datastore User only) so browsers never get any write access to the list.
 */

export class FirestoreConflict extends Error {}

const pemToBytes = (pem) =>
  Uint8Array.from(atob(pem.replace(/-----[A-Z ]+-----/g, '').replace(/\s+/g, '')), (c) => c.charCodeAt(0));

const textBytes = (text) => new TextEncoder().encode(text);

let cached = { token: '', exp: 0 };

async function accessToken(env) {
  if (cached.token && Date.now() < cached.exp - 60_000) return cached.token;
  const sa = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT);
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(textBytes(JSON.stringify({ alg: 'RS256', typ: 'JWT' })));
  const claim = base64url(
    textBytes(
      JSON.stringify({
        iss: sa.client_email,
        scope: 'https://www.googleapis.com/auth/datastore',
        aud: 'https://oauth2.googleapis.com/token',
        iat: now,
        exp: now + 3600,
      })
    )
  );
  const key = await crypto.subtle.importKey(
    'pkcs8',
    pemToBytes(sa.private_key),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, textBytes(`${header}.${claim}`));
  const jwt = `${header}.${claim}.${base64url(new Uint8Array(signature))}`;

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt }),
  });
  if (!res.ok) throw new Error(`Google token request failed (${res.status})`);
  const data = await res.json();
  cached = { token: data.access_token, exp: Date.now() + (data.expires_in || 3600) * 1000 };
  return cached.token;
}

function encodeValue(v) {
  if (v instanceof Date) return { timestampValue: v.toISOString() };
  if (typeof v === 'number') return { integerValue: String(Math.trunc(v)) };
  return { stringValue: String(v) };
}

export const encodeFields = (obj) =>
  Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, encodeValue(v)]));

export function decodeFields(fields = {}) {
  const out = {};
  for (const [k, v] of Object.entries(fields)) {
    if ('stringValue' in v) out[k] = v.stringValue;
    else if ('timestampValue' in v) out[k] = new Date(v.timestampValue);
    else if ('integerValue' in v) out[k] = Number(v.integerValue);
  }
  return out;
}

export class Firestore {
  constructor(env) {
    this.env = env;
    this.base = `https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents`;
  }

  async call(method, url, body) {
    const token = await accessToken(this.env);
    return fetch(url, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
  }

  /** Returns { data, updateTime } or null when the document does not exist. */
  async get(path) {
    const res = await this.call('GET', `${this.base}/${path}`);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Firestore get failed (${res.status})`);
    const doc = await res.json();
    return { data: decodeFields(doc.fields), updateTime: doc.updateTime };
  }

  /** Creates collection/id. Throws FirestoreConflict if it already exists. */
  async create(collection, id, data) {
    const res = await this.call(
      'POST',
      `${this.base}/${collection}?documentId=${encodeURIComponent(id)}`,
      { fields: encodeFields(data) }
    );
    if (res.status === 409) throw new FirestoreConflict();
    if (!res.ok) throw new Error(`Firestore create failed (${res.status})`);
  }

  /**
   * Writes a document, but only if nobody changed it since it was read (updateTime).
   * With `mask` only those fields change, and any mask field missing from `data` is deleted.
   * Without `mask` the whole document is replaced.
   */
  async write(path, data, { updateTime, mask } = {}) {
    const params = new URLSearchParams();
    if (mask) mask.forEach((f) => params.append('updateMask.fieldPaths', f));
    if (updateTime) params.set('currentDocument.updateTime', updateTime);
    const res = await this.call('PATCH', `${this.base}/${path}?${params}`, { fields: encodeFields(data) });
    if (updateTime && [400, 409, 412].includes(res.status)) throw new FirestoreConflict();
    if (!res.ok) throw new Error(`Firestore write failed (${res.status})`);
  }
}
