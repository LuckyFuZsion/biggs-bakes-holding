# Biggs Bakes holding page + admin (free-tier build)

The "Be the first to get Biggs cookies" page, an admin area where the client edits every part of it
(text, images, colours) and manages subscribers, and a secured mailing list backend.
The main Next.js site's sign-up box uses the same backend.

Everything runs on free plans: **Firebase Spark** (database + admin login), **Cloudflare**
(Pages hosting, a Worker for the API, Turnstile bot check, Access for admin 2-step) and **Resend**
(confirmation emails).

## What is in here

| Path | What it is |
|---|---|
| `index.html`, `styles.css`, `main.js` | The public page |
| `content-schema.js` | List of every editable field (used by the page AND the admin) |
| `config.js` | Public settings: API address, Turnstile site key, Firebase web config |
| `admin/` | The admin area at `/admin` |
| `confirm.html`, `unsubscribe.html`, `status.js` | Pages behind the links in emails |
| `worker/` | The Cloudflare Worker API: sign up, confirm, unsubscribe, public content, images |
| `firestore.rules` | Locks the database: only the signed-in admin can touch it |
| `_headers` | Security headers and Content Security Policy for Cloudflare Pages |
| `admin-scripts/create-admin.js` | Creates an admin account |
| `rules-test/` | Security rules tests (need the Firebase emulator) |

## How it works

- **The public page never touches the database.** It asks the Worker for its content
  (`/api/content`, cached at Cloudflare for a minute) and images (`/api/img/...`, cached for a year).
  If anything fails, the page shows its built-in text, so it never looks broken.
- **Admin edits** go straight to Firestore, protected by login and rules that cap field types and
  lengths. Empty field = original built-in version. Edits show on the page within about a minute.
- **Images** are re-drawn in the browser (strips hidden data, fixes the format, shrinks to under
  650 KB), saved as documents in Firestore, and served by the Worker with safe headers.
- **Sign-ups** go to the Worker, which saves the person as *waiting to confirm* and emails a link.
  Pressing the button on the confirm page makes them *confirmed*. The admin's copy list holds
  confirmed people only.
- **Only the Worker can write the subscriber list**, using a service account that has the minimum
  role. No browser can read or write it.

## Protection against bots, spam and attacks

| Layer | What it stops |
|---|---|
| Cloudflare Turnstile on every sign-up (invisible unless it doubts you) | Scripts and bots |
| Hidden honeypot field + minimum fill time | Simple form-filling bots |
| Per-person and overall hourly limits in a Durable Object (IPs stored as hashes) | Floods. Blocked attempts never reach Firestore, so they cannot use up the free daily write quota |
| Strict email checks + throwaway-domain block | Junk and fake addresses |
| Double opt-in (confirm by email, button press needed) | Fake or other people's addresses, link scanners, proves consent |
| Same reply whatever happens | Nobody can test whether an address is on the list |
| Subscribers and content closed to browsers | Reading or injecting list data |
| Content only ever written as plain text; colours and image ids validated everywhere | Code injection through saved content |
| Strict Content Security Policy + security headers (`_headers`) | Injected scripts, clickjacking, sniffing |
| Rules cap field length and type | Oversized or malicious saves |
| Cloudflare network in front of everything | Traffic spikes, many attacks |
| Cloudflare Access in front of `/admin` (step 8) | Anyone reaching the login page at all |

No site can promise zero risk. These layers make attacks expensive and make failures safe.

## Setup (when you are ready)

1. **Firebase (free Spark plan)**: create a project. Add a Web app and copy its config into the
   `firebase` block of `config.js` (apiKey, authDomain, projectId, appId). Enable **Firestore**
   (production mode) and **Authentication > Email/Password**. In Authentication > Settings >
   User actions, turn OFF "Enable create (sign-up)". Under Authentication > Settings > Authorized
   domains, add the site's domain. Add the client as *Owner* under Project settings > Users and
   permissions when you hand over.
2. **Service account for the Worker**: Google Cloud console > IAM > Service accounts > create
   `biggs-worker`. Give it ONLY the role **Cloud Datastore User**. Create a JSON key, keep the file safe.
3. **Rules**: `npm i -g firebase-tools`, `firebase login`, set the project id in `.firebaserc`
   (`firebase use --add`), then `firebase deploy --only firestore`.
4. **Cloudflare Turnstile** (free): add a widget for the domain. Put the **site key** in `config.js`
   (`turnstileSiteKey`) and in the main site's `.env`. Keep the **secret key** for step 6.
5. **Email**: free Resend account, verify the sending domain, create an API key.
6. **Worker**:
   ```bash
   cd worker
   npm install
   npm test
   # edit wrangler.toml: FIREBASE_PROJECT_ID, ALLOWED_ORIGINS, SITE_URL, FROM_EMAIL
   npx wrangler login
   npx wrangler secret put TURNSTILE_SECRET
   npx wrangler secret put RESEND_API_KEY
   npx wrangler secret put HMAC_SECRET              # any long random string
   npx wrangler secret put FIREBASE_SERVICE_ACCOUNT # paste the whole JSON file
   npm run deploy
   ```
   Note the address it prints (`https://biggs-api.<you>.workers.dev`).
7. **Hosting**: Cloudflare Pages > create project > upload this folder (or connect the git repo),
   build command none, output folder the project root. Set `provider: 'live'` in `config.js`. Until
   the domain is on Cloudflare, set `apiBase` to the Worker address and add that address to
   `connect-src` and `img-src` in `_headers` (the `https://*.workers.dev` default already allows it).
   Add `https://<your-pages-address>` to `ALLOWED_ORIGINS` in `wrangler.toml` and redeploy the Worker.
8. **Domain on Cloudflare** (when ready): move the DNS to Cloudflare, attach it to the Pages project,
   uncomment the `routes` line in `wrangler.toml` so the API answers at `yourdomain.com/api/*`, set
   `apiBase: ''` in `config.js`, and tighten `_headers` (remove `*.workers.dev`). Then protect the admin:
   Zero Trust > Access > Applications > add a self-hosted app for `yourdomain.com/admin*`, allow only
   the admin email addresses, with one-time PIN or Google login. That gives free 2-step before anyone
   even sees the Firebase login.
9. **First admin**:
   ```bash
   cd admin-scripts
   npm install
   gcloud auth application-default login
   node create-admin.js person@example.com
   ```
   Send them the link it prints so they set their own password, then they sign in at `/admin`.
10. **Test**, in this order: run the rules tests (`cd rules-test && npm install && npm test`, needs Java),
    sign up with a real address, check the email arrives, confirm it, check it shows in the admin,
    try Copy, try the unsubscribe link from the CSV, upload a test image, save a text change and check
    the page after a minute, and run the worker tests (`cd worker && npm test`).
11. **Main site**: set `NEXT_PUBLIC_SUBSCRIBE_URL` (the Worker address + `/api/subscribe`, or
    `https://yourdomain.com/api/subscribe`) and `NEXT_PUBLIC_TURNSTILE_SITE_KEY` in Vercel, and put the
    main site's address in `ALLOWED_ORIGINS`.

## Free-plan limits to know

Check these on each provider's pricing page before launch, since plans change.

- **Resend free: about 100 emails a day.** Each sign-up sends one confirmation email, so a launch-day
  rush beyond 100 would see the rest fail (the page tells them to try again). If that is a risk, move to
  a provider with a higher free daily limit or a small paid plan just for launch.
- **Firestore free (Spark): about 20,000 writes and 50,000 reads a day.** The Worker's cache keeps page
  views from using reads, and the overall hourly limit (300 by default, `GLOBAL_PER_HOUR`) keeps writes
  well inside the quota.
- **Cloudflare Workers free: 100,000 requests a day.**
- **Firebase on the free plan has no built-in 2-step.** Cloudflare Access (step 8) provides it.
- **Edits take up to a minute** to show, because of caching.
- **Link previews and Google snippets:** the browser tab title and description are edited from the
  admin, but social media previews are fixed (they do not run scripts). The share picture is changed by
  the developer in `index.html`.

## Honest status

- **Tested:** the Worker logic end to end against fakes (sign up, confirm, unsubscribe, bot traps,
  rate limits, wrong origins, oversized bodies, content and image endpoints), email validation, and the
  public page handling hostile content.
- **Not yet tested, because the real services do not exist yet:** talking to real Firestore, Turnstile,
  Resend and Durable Objects; the security rules (tests written, not run); the admin screens.
  Expect a few small fixes during the first end to end run.
- Every marketing email you send must include an unsubscribe link and the company's postal address.
  The CSV has a personal link per person for mail merge.
- Stock, prices and product pages on the main site stay in Shopify.
