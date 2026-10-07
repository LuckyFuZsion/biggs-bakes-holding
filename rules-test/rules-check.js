'use strict';

/**
 * Firestore security rules tests. They need the Firebase emulator (which needs Java), so run them
 * on your machine:
 *
 *   cd rules-test
 *   npm install
 *   npm test
 *
 * They were written but NOT yet run. Run them before the first deploy and after any rules change.
 */

const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { initializeTestEnvironment, assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const { doc, getDoc, setDoc, serverTimestamp, deleteDoc, collection, getDocs } = require('firebase/firestore');

let env;

test.before(async () => {
  env = await initializeTestEnvironment({
    projectId: 'demo-biggs',
    firestore: { rules: fs.readFileSync(path.join(__dirname, '..', 'firestore.rules'), 'utf8') },
  });
});
test.after(async () => env && env.cleanup());

const anon = () => env.unauthenticatedContext().firestore();
const user = () => env.authenticatedContext('u1', { admin: false }).firestore();
const admin = () => env.authenticatedContext('a1', { admin: true }).firestore();
const B64 = 'A'.repeat(200);

test('the public (and ordinary signed-in users) cannot read page content', async () => {
  await assertFails(getDoc(doc(anon(), 'site/holding')));
  await assertFails(getDoc(doc(user(), 'site/holding')));
  await assertSucceeds(getDoc(doc(admin(), 'site/holding')));
});

test('only admins can write page content', async () => {
  const data = { heading: 'Hi', updatedAt: serverTimestamp() };
  await assertFails(setDoc(doc(anon(), 'site/holding'), data));
  await assertFails(setDoc(doc(user(), 'site/holding'), data));
  await assertSucceeds(setDoc(doc(admin(), 'site/holding'), data));
});

test('content rules reject extra fields, long text, bad colours and bad image ids', async () => {
  const base = { updatedAt: serverTimestamp() };
  const db = admin();
  await assertFails(setDoc(doc(db, 'site/holding'), { ...base, evil: 'x' }));
  await assertFails(setDoc(doc(db, 'site/holding'), { ...base, heading: 'x'.repeat(121) }));
  await assertFails(setDoc(doc(db, 'site/holding'), { ...base, green: 'red;background:url(x)' }));
  await assertFails(setDoc(doc(db, 'site/holding'), { ...base, logoUrl: 'javascript:alert(1)' }));
  await assertFails(setDoc(doc(db, 'site/holding'), { ...base, logoUrl: 'https://evil.example/x.png' }));
  await assertFails(setDoc(doc(db, 'site/holding'), { ...base, logoUrl: '../secret' }));
  await assertFails(setDoc(doc(db, 'site/holding'), { ...base, heading: 'Hi', updatedAt: new Date() }));
  await assertSucceeds(setDoc(doc(db, 'site/holding'), { ...base, logoUrl: 'logo-1712345678901', green: '#112233' }));
});

test('only admins can add images, and only small webp or jpeg ones with a proper id', async () => {
  const good = { mime: 'image/webp', b64: B64, createdAt: serverTimestamp() };
  await assertFails(setDoc(doc(anon(), 'images/logo-1712345678901'), good));
  await assertFails(setDoc(doc(user(), 'images/logo-1712345678901'), good));
  await assertSucceeds(setDoc(doc(admin(), 'images/logo-1712345678901'), good));
  await assertFails(setDoc(doc(admin(), 'images/logo-1712345678902'), { ...good, mime: 'image/svg+xml' }));
  await assertFails(setDoc(doc(admin(), 'images/logo-1712345678903'), { ...good, b64: 'A'.repeat(900001) }));
  await assertFails(setDoc(doc(admin(), 'images/logo-1712345678904'), { ...good, extra: 1 }));
  await assertFails(setDoc(doc(admin(), 'images/Bad_Id'), good));
  await assertFails(setDoc(doc(admin(), 'images/logo-1712345678901'), good)); // images never change once saved
});

test('nobody but admins can read subscribers, and nobody can write them from a browser', async () => {
  await assertFails(getDocs(collection(anon(), 'subscribers')));
  await assertFails(getDocs(collection(user(), 'subscribers')));
  await assertSucceeds(getDocs(collection(admin(), 'subscribers')));
  const entry = { email: 'a@b.com', status: 'confirmed' };
  await assertFails(setDoc(doc(anon(), 'subscribers/x'), entry));
  await assertFails(setDoc(doc(user(), 'subscribers/x'), entry));
  await assertFails(setDoc(doc(admin(), 'subscribers/x'), entry)); // even admins go through the Worker
});

test('admins can delete a subscriber, others cannot', async () => {
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'subscribers/del'), { email: 'a@b.com' });
  });
  await assertFails(deleteDoc(doc(anon(), 'subscribers/del')));
  await assertSucceeds(deleteDoc(doc(admin(), 'subscribers/del')));
});

test('anything else is closed', async () => {
  await assertFails(getDoc(doc(admin(), 'anything/else')));
  await assertFails(setDoc(doc(admin(), 'anything/else'), { a: 1 }));
});
