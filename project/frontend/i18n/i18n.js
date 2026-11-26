/* Touracle internationalisation.
 *
 * English is the default and the reference language. Every user-facing string has a
 * stable key; the texts live in frontend/i18n/<locale>.js (window.WM_I18N_RESOURCES).
 * Missing keys fall back to English (and are listed in WM_I18N.missing).
 *
 * Static markup:  data-i18n="key" (text), data-i18n-html (help texts with inline markup),
 *                 data-i18n-title, data-i18n-aria-label,
 *                 data-i18n-placeholder (attributes). The English text in the HTML is only
 *                 the pre-script fallback; a test keeps it identical to en.js.
 * Dynamic UI:     WM_I18N.t(key, {param}) and re-render on the 'wm:languagechange' event.
 * Formatting:     formatNumber / formatDate / monthName use Intl with the active locale.
 */
(function () {
  const SUPPORTED = ['en', 'de', 'fr', 'es', 'zh-CN'];
  const STORAGE_KEY = 'touracle_language';
  const R = (window.WM_I18N_RESOURCES = window.WM_I18N_RESOURCES || {});
  const missing = new Set();

  function stored() {
    try {
      const v = localStorage.getItem(STORAGE_KEY);
      if (SUPPORTED.includes(v)) return v;
    } catch (_) {}
    return 'en';
  }
  let lang = stored();

  function t(key, params) {
    const k = String(key);
    let s = R[lang] && Object.prototype.hasOwnProperty.call(R[lang], k) ? R[lang][k] : undefined;
    if (s === undefined) {
      if (lang !== 'en') missing.add(`${lang}:${k}`);
      s = R.en && Object.prototype.hasOwnProperty.call(R.en, k) ? R.en[k] : undefined;
    }
    if (s === undefined) {
      missing.add(`en:${k}`);
      return k;
    }
    if (params) s = String(s).replace(/\{(\w+)\}/g, (m, p) => (params[p] !== undefined && params[p] !== null ? String(params[p]) : m));
    return s;
  }

  function apply(root) {
    const r = root || document;
    for (const el of r.querySelectorAll('[data-i18n]')) el.textContent = t(el.getAttribute('data-i18n'));
    // Help texts with inline markup (<strong>, <code>): trusted resource strings only.
    for (const el of r.querySelectorAll('[data-i18n-html]')) el.innerHTML = t(el.getAttribute('data-i18n-html'));
    for (const [attr, target] of [['data-i18n-title', 'title'], ['data-i18n-aria-label', 'aria-label'], ['data-i18n-placeholder', 'placeholder']]) {
      for (const el of r.querySelectorAll(`[${attr}]`)) el.setAttribute(target, t(el.getAttribute(attr)));
    }
    if (!root) {
      try { document.documentElement.lang = lang; } catch (_) {}
    }
  }

  function setLanguage(next) {
    const l = SUPPORTED.includes(next) ? next : 'en';
    lang = l;
    try { localStorage.setItem(STORAGE_KEY, l); } catch (_) {}
    apply();
    try { window.dispatchEvent(new CustomEvent('wm:languagechange', { detail: { language: l } })); } catch (_) {}
  }

  const locale = () => lang;
  const nf = {};
  function formatNumber(v, digits = 0) {
    const n = Number(v);
    if (!Number.isFinite(n)) return '—';
    const key = `${lang}|${digits}`;
    if (!nf[key]) nf[key] = new Intl.NumberFormat(locale(), { minimumFractionDigits: digits, maximumFractionDigits: digits });
    return nf[key].format(n);
  }
  function formatDate(iso, opts) {
    try {
      const d = (iso instanceof Date) ? iso : new Date(`${String(iso).slice(0, 10)}T00:00:00`);
      if (Number.isNaN(d.getTime())) return String(iso || '');
      return new Intl.DateTimeFormat(locale(), opts || { day: '2-digit', month: '2-digit', year: 'numeric' }).format(d);
    } catch (_) {
      return String(iso || '');
    }
  }
  function monthName(month1, style = 'short') {
    try {
      return new Intl.DateTimeFormat(locale(), { month: style }).format(new Date(2024, Number(month1) - 1, 1));
    } catch (_) {
      return String(month1);
    }
  }

  window.WM_I18N = { t, apply, setLanguage, getLanguage: () => lang, locale, formatNumber, formatDate, monthName, SUPPORTED, missing };

  function boot() {
    apply();
    const sel = document.getElementById('uiLanguage');
    if (sel) {
      sel.value = lang;
      sel.addEventListener('change', () => setLanguage(sel.value));
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
