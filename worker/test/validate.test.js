import test from 'node:test';
import assert from 'node:assert/strict';
import * as v from '../src/validate.js';

test('accepts normal addresses and normalises case and spaces', () => {
  const email = v.normaliseEmail('  Jane.Doe+cookies@Gmail.com ');
  assert.equal(email, 'jane.doe+cookies@gmail.com');
  assert.equal(v.isValidEmail(email), true);
});

test('rejects malformed addresses', () => {
  for (const bad of ['', 'plain', 'a@b', 'a@@b.com', 'a b@c.com', '.a@b.com', 'a.@b.com', 'a..b@c.com',
    'a@b..com', 'a@-b.com', 'a@b.c', 'a@b.' + 'x'.repeat(30), '<script>@x.com', 'a@b.com\nbcc:x@y.com']) {
    assert.equal(v.isValidEmail(bad), false, bad);
  }
});

test('rejects non-strings and over-long input', () => {
  assert.equal(v.normaliseEmail(null), null);
  assert.equal(v.normaliseEmail({ a: 1 }), null);
  assert.equal(v.normaliseEmail('a'.repeat(300) + '@x.com'), null);
});

test('addresses can never start with a spreadsheet formula character', () => {
  for (const bad of ['=cmd@x.com', '+1@x.com', '-1@x.com', '@x@y.com']) {
    assert.equal(v.isValidEmail(bad), false, bad);
  }
});

test('blocks disposable domains and their subdomains', () => {
  assert.equal(v.isDisposable('x@mailinator.com'), true);
  assert.equal(v.isDisposable('x@foo.mailinator.com'), true);
  assert.equal(v.isDisposable('x@gmail.com'), false);
  assert.equal(v.isDisposable('x@notmailinator.com'), false);
});

test('tokens, ids and signatures', async () => {
  const token = v.newToken();
  assert.equal(v.isToken(token), true);
  assert.equal(v.isToken(token + 'x'), false);
  assert.equal(v.isToken('<script>'), false);
  const id = await v.sha256Hex('a@b.com');
  assert.equal(v.isDocId(id), true);
  assert.equal(v.isDocId(id.toUpperCase()), false);
  const sig = await v.hmacHex('secret', 'unsub:' + id);
  assert.equal(v.safeEqualHex(sig, await v.hmacHex('secret', 'unsub:' + id)), true);
  assert.equal(v.safeEqualHex(sig, await v.hmacHex('other', 'unsub:' + id)), false);
  assert.equal(v.safeEqualHex(sig, 'zz'), false);
  assert.equal(v.safeEqualHex(undefined, sig), false);
});

test('image ids only allow the expected shape', () => {
  assert.equal(v.isImageId('logo-1712345678901'), true);
  assert.equal(v.isImageId('../etc/passwd'), false);
  assert.equal(v.isImageId('logo-12'), false);
  assert.equal(v.isImageId('Logo-1712345678901'), false);
});

test('cleanText strips control characters and angle brackets', () => {
  assert.equal(v.cleanText('hi <b>there</b>\u0000', 50), 'hi  b there /b');
  assert.equal(v.cleanText(123, 50), '');
  assert.equal(v.cleanText('x'.repeat(500), 10).length, 10);
});
