import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js';
import {
  getAuth, signInWithEmailAndPassword, signOut, onAuthStateChanged, sendPasswordResetEmail,
  getMultiFactorResolver, multiFactor, TotpMultiFactorGenerator,
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js';
import {
  getFirestore, doc, getDoc, setDoc, collection, query, orderBy, onSnapshot, deleteDoc, serverTimestamp,
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';

/* Everything user supplied (emails, saved text) is written with textContent or as an attribute
   value through h() below. Nothing is ever inserted as HTML. */

const SCHEMA = window.BIGGS_SCHEMA || [];
const IMAGE_ID = window.BIGGS_IMAGE_ID;
const MAX_IMAGE_BYTES = 650 * 1024; // keeps each image document safely under Firestore's 1 MB limit
const cfg = (window.BIGGS_CONFIG && window.BIGGS_CONFIG.firebase) || {};
const $ = (sel) => document.querySelector(sel);

function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const kid of kids.flat()) {
    if (kid == null) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

function say(selector, text, kind) {
  const el = $(selector);
  el.textContent = text;
  el.className = 'notice' + (kind ? ' ' + kind : '');
}

if (!cfg.apiKey || !cfg.projectId) {
  $('#setup-warning').hidden = false;
  throw new Error('Firebase config missing');
}

const app = initializeApp(cfg);
const auth = getAuth(app);
const db = getFirestore(app);

const views = { login: $('#view-login'), mfa: $('#view-mfa'), app: $('#view-app') };
function show(name) {
  for (const [key, el] of Object.entries(views)) el.hidden = key !== name;
  $('#signout').hidden = name !== 'app';
}

// ------------------------------------------------------------------ sign in
let mfaResolver = null;

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = e.submitter;
  btn.disabled = true;
  say('#login-msg', '');
  try {
    await signInWithEmailAndPassword(auth, $('#login-email').value.trim(), $('#login-password').value);
  } catch (err) {
    if (err.code === 'auth/multi-factor-auth-required') {
      mfaResolver = getMultiFactorResolver(auth, err);
      show('mfa');
      $('#mfa-code').focus();
    } else if (err.code === 'auth/too-many-requests') {
      say('#login-msg', 'Too many attempts. Please wait a few minutes and try again.', 'error');
    } else {
      say('#login-msg', 'Sign in failed. Check your email and password.', 'error'); // never says which was wrong
    }
  } finally {
    btn.disabled = false;
    $('#login-password').value = '';
  }
});

$('#mfa-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = e.submitter;
  btn.disabled = true;
  try {
    const hint = mfaResolver.hints.find((x) => x.factorId === TotpMultiFactorGenerator.FACTOR_ID);
    const assertion = TotpMultiFactorGenerator.assertionForSignIn(hint.uid, $('#mfa-code').value.trim());
    await mfaResolver.resolveSignIn(assertion);
    mfaResolver = null;
    $('#mfa-code').value = '';
  } catch {
    say('#mfa-msg', 'That code was not accepted. Try the newest code.', 'error');
  } finally {
    btn.disabled = false;
  }
});

$('#signout').addEventListener('click', () => signOut(auth));

// Sign out after 30 minutes without activity.
let idleTimer;
function resetIdle() {
  clearTimeout(idleTimer);
  if (auth.currentUser) idleTimer = setTimeout(() => signOut(auth), 30 * 60 * 1000);
}
['click', 'keydown', 'pointermove'].forEach((evt) => window.addEventListener(evt, resetIdle, { passive: true }));

let stopSubscribers = null;
onAuthStateChanged(auth, async (user) => {
  if (!user) {
    if (stopSubscribers) stopSubscribers();
    stopSubscribers = null;
    $('#who').textContent = '';
    show(mfaResolver ? 'mfa' : 'login');
    return;
  }
  const token = await user.getIdTokenResult(true);
  if (token.claims.admin !== true) {
    await signOut(auth);
    say('#login-msg', 'This account is not an admin.', 'error');
    return;
  }
  $('#who').textContent = user.email;
  show('app');
  resetIdle();
  startContent();
  startSubscribers();
  refreshMfaStatus();
});

// ------------------------------------------------------------------ tabs
document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('is-active', t === tab));
    for (const name of ['content', 'subscribers', 'security']) {
      $('#tab-' + name).hidden = tab.dataset.tab !== name;
    }
  });
});

// ------------------------------------------------------------------ page content
const inputs = {}; // key -> () => current value
let savedContent = {};

async function startContent() {
  const snap = await getDoc(doc(db, 'site', 'holding'));
  savedContent = snap.exists() ? snap.data() : {};
  buildForm();
}

function luminance(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

function buildForm() {
  const form = $('#content-form');
  form.replaceChildren();
  let group = '';

  for (const field of SCHEMA) {
    if (field.group !== group) {
      group = field.group;
      form.append(h('h2', { class: 'group-title' }, group));
    }
    const current = typeof savedContent[field.key] === 'string' ? savedContent[field.key] : '';
    const id = 'f-' + field.key;

    if (field.type === 'image') {
      form.append(imageField(field, id, current));
    } else if (field.type === 'color') {
      form.append(colorField(field, id, current));
    } else {
      const control = field.type === 'textarea'
        ? h('textarea', { id, maxlength: field.max })
        : h('input', { id, type: 'text', maxlength: field.max });
      control.value = current;
      control.placeholder = field.def || '';
      const count = h('span', { class: 'count' });
      const update = () => { count.textContent = `${control.value.length}/${field.max}`; };
      control.addEventListener('input', update);
      update();
      inputs[field.key] = () => control.value.trim();
      form.append(h('div', { class: 'field' }, h('label', { for: id }, field.label, count), control));
    }
  }
  updateContrastWarning();
}

function colorField(field, id, current) {
  const picker = h('input', { id, type: 'color' });
  picker.value = current || field.def;
  const label = h('code', null, picker.value);
  const reset = h('button', { class: 'ghost', type: 'button', onclick: () => { picker.value = field.def; picker.dispatchEvent(new Event('input')); } }, 'Use original');
  picker.addEventListener('input', () => { label.textContent = picker.value; updateContrastWarning(); });
  inputs[field.key] = () => (picker.value.toLowerCase() === field.def.toLowerCase() ? '' : picker.value.toLowerCase());
  inputs['_picker_' + field.key] = () => picker.value;
  return h('div', { class: 'field' }, h('label', { for: id }, field.label), h('div', { class: 'color-row' }, picker, label, reset));
}

function updateContrastWarning() {
  const get = (k) => (inputs['_picker_' + k] ? inputs['_picker_' + k]() : null);
  const green = get('green');
  const cream = get('cream');
  const yellow = get('yellow');
  $('#colour-warning')?.remove();
  if (!green || !cream || !yellow) return;
  const problems = [];
  if (contrast(green, cream) < 4.5) problems.push('the text and card colours are too similar to read easily');
  if (contrast(green, yellow) < 3) problems.push('the button will be hard to see against the card');
  if (!problems.length) return;
  const rows = $('#content-form').querySelectorAll('.color-row');
  const last = rows[rows.length - 1];
  if (last) last.parentElement.after(h('p', { id: 'colour-warning', class: 'contrast-warning' }, 'Careful: ' + problems.join(' and ') + '.'));
}

async function blobToBase64(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

function imageField(field, id, current) {
  const preview = h('img', { alt: '' });
  let value = IMAGE_ID.test(current) ? current : '';
  const status = h('p', { class: 'hint' }, field.hint || '');
  const file = h('input', { id, type: 'file', accept: 'image/jpeg,image/png,image/webp' });

  if (value) {
    getDoc(doc(db, 'images', value)).then((snap) => {
      if (snap.exists()) preview.src = `data:${snap.data().mime};base64,${snap.data().b64}`;
    }).catch(() => {});
  }

  file.addEventListener('change', async () => {
    const chosen = file.files[0];
    if (!chosen) return;
    status.textContent = 'Preparing and uploading...';
    try {
      const blob = await processImage(chosen, field.maxDim, field.format);
      const imageId = `${field.idPrefix}-${Date.now()}`;
      await setDoc(doc(db, 'images', imageId), {
        mime: blob.type,
        b64: await blobToBase64(blob),
        createdAt: serverTimestamp(),
      });
      value = imageId;
      preview.src = URL.createObjectURL(blob);
      status.textContent = 'Uploaded. Press Save and publish to put it on the page.';
    } catch (err) {
      status.textContent = err.message || 'Upload failed. Please try another image.';
    }
    file.value = '';
  });

  const remove = h('button', { class: 'ghost', type: 'button', onclick: () => { value = ''; preview.removeAttribute('src'); status.textContent = 'Will use the original image after saving.'; } }, 'Use original image');
  inputs[field.key] = () => value;
  return h('div', { class: 'field' }, h('label', { for: id }, field.label),
    h('div', { class: 'image-row' }, preview, h('div', { class: 'controls' }, file, remove, status)));
}

/** Re-draws the picture onto a canvas. That strips any hidden data, fixes the format, and shrinks it. */
async function processImage(file, maxDim, format) {
  if (!/^image\/(jpeg|png|webp)$/.test(file.type)) throw new Error('Please choose a JPG, PNG or WebP image.');
  if (file.size > 20 * 1024 * 1024) throw new Error('That file is over 20 MB. Please choose a smaller one.');
  const bitmap = await createImageBitmap(file);
  const type = format === 'jpeg' ? 'image/jpeg' : 'image/webp';
  let scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height));

  // Shrink quality, then size, until it is small enough to store (about 650 KB).
  for (let attempt = 0; attempt < 6; attempt++) {
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const ctx = canvas.getContext('2d');
    if (format === 'jpeg') { ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, canvas.width, canvas.height); }
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    for (const quality of [0.88, 0.78, 0.68]) {
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, type, quality));
      if (!blob || blob.type !== type) throw new Error('This browser could not prepare the image.');
      if (blob.size <= MAX_IMAGE_BYTES) return blob;
    }
    scale *= 0.8;
  }
  throw new Error('That picture is too detailed to shrink enough. Please try a simpler or smaller image.');
}

$('#save-content').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true;
  say('#content-msg', 'Saving...');
  try {
    const data = {};
    for (const field of SCHEMA) {
      const value = inputs[field.key]();
      if (typeof value !== 'string' || value === '') continue;
      if (field.type === 'image' && !IMAGE_ID.test(value)) continue;
      data[field.key] = value;
    }
    data.updatedAt = serverTimestamp();
    await setDoc(doc(db, 'site', 'holding'), data);
    say('#content-msg', 'Saved. The live page shows it within about a minute.', 'ok');
  } catch (err) {
    say('#content-msg', err.code === 'permission-denied'
      ? 'Not saved: something is too long or not allowed. Check the highlighted limits.'
      : 'Not saved. Please try again.', 'error');
  } finally {
    btn.disabled = false;
  }
});

// ------------------------------------------------------------------ subscribers
let subscribers = [];

function startSubscribers() {
  if (stopSubscribers) stopSubscribers();
  const q = query(collection(db, 'subscribers'), orderBy('createdAt', 'desc'));
  stopSubscribers = onSnapshot(q, (snap) => {
    subscribers = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderSubscribers();
  }, () => say('#sub-msg', 'Could not load subscribers.', 'error'));
}

const fmtDate = (ts) => (ts && ts.toDate ? ts.toDate().toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' }) : '');

function visibleSubscribers() {
  const status = $('#sub-filter').value;
  const term = $('#sub-search').value.trim().toLowerCase();
  return subscribers.filter((s) => (status === 'all' || s.status === status) && (!term || String(s.email).includes(term)));
}

function renderSubscribers() {
  const count = (status) => subscribers.filter((s) => s.status === status).length;
  $('#stats').replaceChildren(
    ...[['Confirmed', count('confirmed')], ['Waiting to confirm', count('pending')], ['Unsubscribed', count('unsubscribed')]]
      .map(([label, n]) => h('div', { class: 'stat' }, h('b', null, n), label))
  );
  $('#copy-all').textContent = `Copy all confirmed emails (${count('confirmed')})`;

  const rows = visibleSubscribers().map((s) => h('tr', null,
    h('td', null, s.email),
    h('td', null, h('span', { class: 'badge ' + s.status }, s.status === 'pending' ? 'waiting' : s.status)),
    h('td', null, s.source || ''),
    h('td', null, fmtDate(s.createdAt)),
    h('td', null, h('button', {
      class: 'danger', type: 'button',
      onclick: async () => {
        if (!confirm(`Permanently delete ${s.email}? This cannot be undone.`)) return;
        try { await deleteDoc(doc(db, 'subscribers', s.id)); } catch { say('#sub-msg', 'Could not delete.', 'error'); }
      },
    }, 'Delete'))
  ));
  $('#sub-rows').replaceChildren(...(rows.length ? rows : [h('tr', null, h('td', { colspan: 5 }, 'Nothing to show yet.'))]));
}

$('#sub-filter').addEventListener('change', renderSubscribers);
$('#sub-search').addEventListener('input', renderSubscribers);

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = h('textarea', { 'aria-hidden': 'true' });
    area.value = text;
    document.body.append(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  }
}

$('#copy-all').addEventListener('click', async () => {
  const emails = subscribers.filter((s) => s.status === 'confirmed').map((s) => s.email);
  if (!emails.length) return say('#sub-msg', 'There are no confirmed subscribers yet.', 'error');
  const raw = $('#copy-sep').value;
  const sep = raw === '\\n' ? '\n' : raw;
  const ok = await copyText(emails.join(sep));
  say('#sub-msg', ok ? `Copied ${emails.length} email addresses. Paste them into the BCC box.` : 'Could not copy. Try the CSV download.', ok ? 'ok' : 'error');
});

function csvCell(value) {
  let text = String(value ?? '');
  if (/^[=+\-@\t\r]/.test(text)) text = "'" + text; // stops spreadsheet formula injection
  return `"${text.replace(/"/g, '""')}"`;
}

$('#download-csv').addEventListener('click', () => {
  const rows = [['email', 'status', 'source', 'signed_up', 'confirmed', 'unsubscribe_link']];
  for (const s of visibleSubscribers()) {
    const link = s.unsubSig ? `${location.origin}/unsubscribe.html?id=${s.id}&s=${s.unsubSig}` : '';
    rows.push([s.email, s.status, s.source, fmtDate(s.createdAt), fmtDate(s.confirmedAt), link]);
  }
  const blob = new Blob([rows.map((r) => r.map(csvCell).join(',')).join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const a = h('a', { href: URL.createObjectURL(blob), download: `biggs-subscribers-${new Date().toISOString().slice(0, 10)}.csv` });
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
});

// ------------------------------------------------------------------ security
let totpSecret = null;

function refreshMfaStatus() {
  const enrolled = multiFactor(auth.currentUser).enrolledFactors.length > 0;
  $('#mfa-status').textContent = enrolled
    ? 'On. You are asked for a code from your authenticator app each time you sign in.'
    : 'Off. Turn this on: a stolen password alone should never be enough to open this admin.';
  $('#mfa-start').hidden = enrolled;
  $('#mfa-setup').hidden = true;
}

$('#mfa-start').addEventListener('click', async () => {
  try {
    const session = await multiFactor(auth.currentUser).getSession();
    totpSecret = await TotpMultiFactorGenerator.generateSecret(session);
    $('#mfa-secret').textContent = totpSecret.secretKey;
    $('#mfa-setup').hidden = false;
    $('#mfa-start').hidden = true;
  } catch (err) {
    say('#security-msg', err.code === 'auth/requires-recent-login'
      ? 'Please sign out and in again, then try once more.'
      : 'In-app 2-step needs a paid Firebase upgrade. On the free plan, 2-step is provided by Cloudflare Access in front of this page (see the README).', 'error');
  }
});

$('#mfa-enrol-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const assertion = TotpMultiFactorGenerator.assertionForEnrollment(totpSecret, $('#mfa-enrol-code').value.trim());
    await multiFactor(auth.currentUser).enroll(assertion, 'Authenticator app');
    say('#security-msg', '2-step verification is on.', 'ok');
    refreshMfaStatus();
  } catch {
    say('#security-msg', 'That code was not accepted. Try the newest code.', 'error');
  }
});

$('#reset-password').addEventListener('click', async () => {
  try {
    await sendPasswordResetEmail(auth, auth.currentUser.email);
    say('#security-msg', 'Check your inbox for the reset link.', 'ok');
  } catch {
    say('#security-msg', 'Could not send the email. Try again shortly.', 'error');
  }
});
