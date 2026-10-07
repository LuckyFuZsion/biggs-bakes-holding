/**
 * Settings for the holding page and the admin area. These values are PUBLIC by design
 * (they are in every web page that uses Firebase or Turnstile). Real secrets live in the
 * Worker, never here.
 *
 * provider: 'live'  sign-ups go to the secured Worker, content is loaded through it
 * provider: 'demo'  (default) preview only: nothing is sent or saved, and the page says so
 *
 * apiBase:  '' when the Worker is routed on the same domain (biggsbakes.com/api/*).
 *           Before the domain moves to Cloudflare, use the Worker's own address instead,
 *           e.g. 'https://biggs-api.YOURNAME.workers.dev' (no trailing slash).
 *
 * firebase: the "Web app" config from Firebase console > Project settings. Used by /admin only.
 * turnstileSiteKey: the SITE key from Cloudflare Turnstile (never the secret key).
 */
window.BIGGS_CONFIG = {
  provider: 'demo',
  apiBase: '',
  turnstileSiteKey: '0x4AAAAAAFQwq6Oeh7IDNhPh',
  source: 'holding-page',
  firebase: {
    apiKey: 'AIzaSyBLCZQyryWsOnEjC2s1vpLrBr6zpocrz2c',
    authDomain: 'biggs-6ed18.firebaseapp.com',
    projectId: 'biggs-6ed18',
    appId: '1:956520683418:web:2524b6dcb05df4372b0c23',
  },
};
