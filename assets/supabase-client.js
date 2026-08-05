// Wama-Pay – lädt supabase-js per CDN (mit Fallback) und stellt
// window.wamaSupabaseReady als Promise bereit, das den initialisierten
// Client liefert. Erwartet, dass assets/config.js vorher geladen wurde.
(function () {
  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      var s = document.createElement("script");
      s.src = src;
      s.onload = resolve;
      s.onerror = reject;
      document.head.appendChild(s);
    });
  }

  function loadSupabaseLib() {
    if (window.supabase) return Promise.resolve();
    return loadScript("https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js")
      .catch(function () {
        return loadScript("https://unpkg.com/@supabase/supabase-js@2/dist/umd/supabase.min.js");
      });
  }

  window.wamaSupabaseReady = loadSupabaseLib().then(function () {
    var cfg = window.WAMA_PAY_CONFIG || {};
    if (!cfg.supabaseUrl || cfg.supabaseUrl.indexOf("TODO_") === 0) {
      console.warn("Wama-Pay: assets/config.js ist noch nicht mit echten Supabase-Werten befüllt.");
    }
    return window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey);
  });
})();
