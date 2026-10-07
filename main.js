(function () {
  'use strict';

  var config = window.BIGGS_CONFIG || { provider: 'demo' };
  var schema = window.BIGGS_SCHEMA || [];
  var imageId = window.BIGGS_IMAGE_ID || /^[a-z]{2,12}-\d{10,14}$/;
  var apiBase = (config.apiBase || '').replace(/\/+$/, '');
  var isLive = config.provider === 'live';

  var form = document.getElementById('signup-form');
  var message = document.getElementById('form-message');
  var emailInput = document.getElementById('email');
  var button = document.getElementById('submit-btn');
  var consentEl = document.getElementById('consent');

  var loadedAt = Date.now();
  var content = {};
  var turnstileToken = '';
  var turnstileWidget = null;

  var EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
  var DEFAULT_SUCCESS = 'Thanks! Check your inbox and click the link to confirm.';
  var ERRORS = {
    invalid_email: 'That email address does not look right. Please check it and try again.',
    rate_limited: 'Too many attempts. Please try again in a little while.',
    bot_check: 'We could not confirm you are a real person. Please refresh the page and try again.',
    email_failed: 'We could not send the confirmation email. Please try again in a moment.',
  };
  var GENERIC_ERROR = 'Something went wrong. Please try again in a moment.';

  function setMessage(text, kind) {
    message.textContent = text; // plain text only, never HTML
    message.className = 'message' + (kind ? ' is-' + kind : '');
  }

  // ------------------------------------------------------------------ saved content
  // Values come from the database but are only ever written as plain text, a validated
  // image address, or a validated colour. Nothing is inserted as HTML.
  function imageUrl(id) {
    return typeof id === 'string' && imageId.test(id) ? apiBase + '/api/img/' + id : '';
  }

  function applyContent(data) {
    schema.forEach(function (field) {
      var value = data[field.key];
      if (typeof value !== 'string' || value === '') return;
      var el = field.target ? document.querySelector(field.target) : null;

      switch (field.as) {
        case 'text':
          if (el) el.textContent = value;
          break;
        case 'placeholder':
          if (el) el.setAttribute('placeholder', value);
          break;
        case 'aria':
          if (el) el.setAttribute('aria-label', value);
          break;
        case 'alt':
          if (el) el.setAttribute('alt', value);
          break;
        case 'src':
          if (el && imageUrl(value)) el.setAttribute('src', imageUrl(value));
          break;
        case 'metadesc':
          if (el) el.setAttribute('content', value);
          break;
        case 'title':
          document.title = value;
          break;
        case 'cssvar':
          if (/^#[0-9a-fA-F]{6}$/.test(value)) document.documentElement.style.setProperty(field.cssvar, value);
          break;
      }
    });
  }

  function loadContent() {
    if (!isLive) return;
    fetch(apiBase + '/api/content', { signal: AbortSignal.timeout ? AbortSignal.timeout(5000) : undefined })
      .then(function (res) {
        return res.ok ? res.json() : null; // nothing saved yet: keep the built-in text
      })
      .then(function (data) {
        if (!data || !data.content || typeof data.content !== 'object') return;
        content = data.content;
        applyContent(content);
      })
      .catch(function () {
        /* page keeps its built-in content */
      });
  }

  // ------------------------------------------------------------------ bot check
  function loadTurnstile() {
    if (!isLive || !config.turnstileSiteKey) return;
    var script = document.createElement('script');
    script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    script.async = true;
    script.onload = function () {
      if (!window.turnstile) return;
      turnstileWidget = window.turnstile.render('#turnstile', {
        sitekey: config.turnstileSiteKey,
        appearance: 'interaction-only', // invisible unless Cloudflare needs a challenge
        callback: function (token) { turnstileToken = token; },
        'expired-callback': function () { turnstileToken = ''; },
        'error-callback': function () { turnstileToken = ''; },
      });
    };
    document.head.appendChild(script);
  }

  function resetTurnstile() {
    turnstileToken = '';
    if (window.turnstile && turnstileWidget !== null) window.turnstile.reset(turnstileWidget);
  }

  // ------------------------------------------------------------------ sending
  function send(email) {
    if (!isLive) {
      return new Promise(function (resolve) { setTimeout(function () { resolve({ demo: true }); }, 400); });
    }
    return fetch(apiBase + '/api/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: email,
        token: turnstileToken,
        hp: form.elements.company ? form.elements.company.value : '',
        elapsed: Date.now() - loadedAt,
        source: config.source || 'holding-page',
        consent: consentEl.textContent.replace(/\s+/g, ' ').trim(),
      }),
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!res.ok || !data.ok) {
          var err = new Error(data.error || 'failed');
          err.code = data.error;
          throw err;
        }
        return data;
      });
    });
  }

  form.addEventListener('submit', function (event) {
    event.preventDefault();

    var email = emailInput.value.trim();
    if (!EMAIL_PATTERN.test(email)) {
      setMessage(ERRORS.invalid_email, 'error');
      emailInput.focus();
      return;
    }
    if (isLive && config.turnstileSiteKey && !turnstileToken) {
      setMessage('One moment, checking you are a real person. Please press the button again.', 'error');
      return;
    }

    button.disabled = true;
    setMessage('', '');

    send(email)
      .then(function (result) {
        form.hidden = true;
        consentEl.hidden = true;
        if (result && result.demo) {
          console.warn('Biggs holding page: provider is "demo", the email was NOT saved.');
          setMessage('Demo mode: your email was NOT saved. Set provider to "live" in config.js.', 'error');
          return;
        }
        setMessage(content.successMessage || DEFAULT_SUCCESS, 'success');
      })
      .catch(function (err) {
        button.disabled = false;
        resetTurnstile();
        setMessage(ERRORS[err && err.code] || GENERIC_ERROR, 'error');
      });
  });

  loadContent();
  loadTurnstile();
})();
