// Lightweight i18n for BhoomiCare AI.
//
// Static UI chrome (labels, buttons, headers, notifications) is translated
// via the dictionaries in this file. AI-generated advice text is translated
// separately, on the backend, by asking Gemini to translate the already-
// generated English advice into the selected language (see server.js
// translateAdvice()) — script.js sends the language via getCurrentLang().

(function () {
  const SUPPORTED_LANGS = ['en', 'hi', 'bn', 'ta', 'te', 'mr'];
  const STORAGE_KEY = 'bhoomicare_lang';

  // English fallback so t() never returns undefined, even before the
  // language JSON has finished loading (avoids a flash of "undefined" text
  // in dynamically-generated strings like notifications).
  const FALLBACK_EN = {
    results_title_suffix: 'Advisory Dashboard',
    notif_fill_required: 'Please fill in all required fields',
    notif_success: 'Recommendations loaded successfully!',
    notif_failure: 'Failed to get recommendations. Please try again.',
    photo_choose_first: 'Choose a photo first.',
    photo_analyzing: 'Analyzing...',
    photo_done: 'Done',
    photo_analysis_failed: 'Analysis failed. Please try again.',
    pest_none: 'No specific pest alerts for your crop at this time. Continue regular monitoring.',
    pest_load_error: 'Unable to load pest alerts. Please check your internet connection.',
    forecast_load_error: 'Unable to load weather forecast. Please check your internet connection.',
    severity_high: 'High Risk',
    severity_medium: 'Medium Risk',
    severity_low: 'Low Risk',
    pest_prevention_label: 'Prevention:'
  };

  let translations = {};
  let currentLang = 'en';

  function getSavedLang() {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      return SUPPORTED_LANGS.includes(saved) ? saved : 'en';
    } catch (e) {
      return 'en'; // localStorage can throw in some privacy modes
    }
  }

  // Exposed globally so script.js can translate dynamically-generated
  // strings (notifications, status messages, etc.) with the same dictionary.
  window.t = function (key) {
    return translations[key] || FALLBACK_EN[key] || key;
  };

  // Exposed so script.js can send the selected language to the backend
  // when submitting a crop query, so advice text can be translated too.
  window.getCurrentLang = function () {
    return currentLang;
  };

  function applyTranslations() {
    document.querySelectorAll('[data-i18n]').forEach(el => {
      const key = el.dataset.i18n;
      if (translations[key]) {
        el.textContent = translations[key];
      }
    });
    document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
      const key = el.dataset.i18nPlaceholder;
      if (translations[key]) {
        el.placeholder = translations[key];
      }
    });
    document.documentElement.lang = currentLang;

    // Let script.js know translations changed, so it can refresh any
    // dynamically-built strings that mix translated + non-translated parts
    // (e.g. "<CropName> Advisory Dashboard") without this module needing
    // to know about script.js's internal state.
    document.dispatchEvent(new CustomEvent('i18nchange'));
  }

  async function loadLanguage(lang) {
    if (!SUPPORTED_LANGS.includes(lang)) lang = 'en';
    currentLang = lang;
    try {
      const res = await fetch(`/i18n/${lang}.json`);
      translations = await res.json();
    } catch (e) {
      console.error('Failed to load language file for', lang, e);
      translations = {};
    }
    applyTranslations();
  }

  document.addEventListener('DOMContentLoaded', () => {
    const saved = getSavedLang();
    const switcher = document.getElementById('languageSwitcher');
    if (switcher) {
      switcher.value = saved;
      switcher.addEventListener('change', (e) => {
        const lang = e.target.value;
        try { localStorage.setItem(STORAGE_KEY, lang); } catch (e) { /* ignore */ }
        loadLanguage(lang);
      });
    }
    loadLanguage(saved);
  });
})();
