'use strict';

/**
 * Creates (or upgrades) an admin account. Run it from the admin-scripts folder:
 *
 *   cd admin-scripts
 *   npm install
 *   gcloud auth application-default login      (once, as the Firebase project owner)
 *   node create-admin.js you@example.com
 *
 * It never handles a password. It prints a one-time link where the person sets their own.
 * It marks the email as verified, which Firebase needs before 2-step verification can be enrolled.
 */

const admin = require('firebase-admin');

const email = (process.argv[2] || '').trim().toLowerCase();
if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
  console.error('Usage: node create-admin.js person@example.com');
  process.exit(1);
}

admin.initializeApp(); // uses GOOGLE_CLOUD_PROJECT or the active gcloud project

(async () => {
  const auth = admin.auth();
  let user;
  try {
    user = await auth.getUserByEmail(email);
  } catch {
    user = await auth.createUser({ email, emailVerified: true });
  }
  if (!user.emailVerified) await auth.updateUser(user.uid, { emailVerified: true });
  await auth.setCustomUserClaims(user.uid, { admin: true });
  const link = await auth.generatePasswordResetLink(email);
  console.log(`\n${email} is now an admin (they must sign out and in again if already signed in).`);
  console.log('Send them this link so they can choose their own password:\n');
  console.log(link + '\n');
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
