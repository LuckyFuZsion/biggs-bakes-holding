import DISPOSABLE from './disposable.js';

const enc = new TextEncoder();

// Deliberately strict: ASCII only, must start and end the local part with a letter or digit.
// That also means an address can never start with = + - @ (spreadsheet formula injection).
const EMAIL_RE =
  /^[a-z0-9](?:[a-z0-9._%+-]{0,62}[a-z0-9])?@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$/;

export function normaliseEmail(value) {
  if (typeof value !== 'string') return null;
  const email = value.trim().toLowerCase();
  return email.length > 0 && email.length <= 254 ? email : null;
}

export function isValidEmail(email) {
  return typeof email === 'string' && email.length <= 254 && EMAIL_RE.test(email) && !email.includes('..');
}

export function isDisposable(email) {
  const domain = email.split('@')[1] || '';
  for (const bad of DISPOSABLE) {
    if (domain === bad || domain.endsWith('.' + bad)) return true;
  }
  return false;
}

export const toHex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

export async function sha256Hex(text) {
  return toHex(await crypto.subtle.digest('SHA-256', enc.encode(text)));
}

export async function hmacHex(secret, text) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return toHex(await crypto.subtle.sign('HMAC', key, enc.encode(text)));
}

export function base64url(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** 32 random bytes as 43 URL-safe characters. */
export const newToken = () => base64url(crypto.getRandomValues(new Uint8Array(32)));

export const isDocId = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export const isToken = (value) => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);
export const isImageId = (value) => typeof value === 'string' && /^[a-z]{2,12}-\d{10,14}$/.test(value);

/** Comparison that does not stop at the first different character. */
export function safeEqualHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Plain text for the consent record: no control characters or angle brackets, capped length. */
export function cleanText(value, max) {
  if (typeof value !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u001f\u007f<>]/g, ' ').trim().slice(0, max);
}
