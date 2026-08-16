// Wama-Pay – lädt eine kleine QR-Code-Generator-Bibliothek per CDN (mit
// Fallback), analog zu assets/supabase-client.js. Stellt
// window.wamaQrcodeReady als Promise bereit, das die globale `qrcode()`-
// Fabrikfunktion liefert (API: qrcode(typeNumber, errorCorrectionLevel),
// dann .addData(text), .make(), .createSvgTag({cellSize, margin})).
//
// Bibliothek: kazuhikoarase/qrcode-generator (MIT-Lizenz), seit Jahren
// stabile API, keine Abhängigkeiten.
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

  function loadQrLib() {
    if (window.qrcode) return Promise.resolve();
    return loadScript("https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/qrcode.js")
      .catch(function () {
        return loadScript("https://unpkg.com/qrcode-generator@1.4.4/qrcode.js");
      });
  }

  window.wamaQrcodeReady = loadQrLib().then(function () {
    return window.qrcode;
  });

  // Rendert `text` als QR-Code-SVG in das Element mit der ID `containerId`.
  window.wamaRenderQrCode = function (containerId, text) {
    return window.wamaQrcodeReady.then(function (qrcodeFactory) {
      var qr = qrcodeFactory(0, "M");
      qr.addData(text);
      qr.make();
      var el = document.getElementById(containerId);
      if (el) el.innerHTML = qr.createSvgTag({ cellSize: 5, margin: 4 });
    });
  };
})();
