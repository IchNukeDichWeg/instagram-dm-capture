// Runs in the page's own JS world (MAIN) at document_start, so it wraps
// fetch/XHR before Instagram's code grabs references to them. It only reads
// responses; requests go through untouched.
(() => {
  if (window.__igdmCaptureHooked) return;
  window.__igdmCaptureHooked = true;

  const TAG = 'igdm-capture';
  // Cheap pre-filter: only bodies that can contain thread messages cross the
  // bridge. Everything else (feeds, likes, ...) is dropped here.
  const MARKER = 'slide_messages';
  const isGraphql = (url) => /\/(api\/)?graphql/.test(String(url || ''));

  function emit(url, text) {
    if (typeof text !== 'string' || !text.includes(MARKER)) return;
    window.postMessage({ source: TAG, url: String(url), body: text }, window.location.origin);
  }

  const origFetch = window.fetch;
  window.fetch = function (input, init) {
    const p = origFetch.apply(this, arguments);
    try {
      const url = input instanceof Request ? input.url : String(input);
      if (isGraphql(url)) {
        p.then((r) => r.clone().text()).then((t) => emit(url, t)).catch(() => {});
      }
    } catch (_) {}
    return p;
  };

  const xhrUrl = new WeakMap();
  const origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    xhrUrl.set(this, String(url));
    return origOpen.apply(this, arguments);
  };

  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function () {
    const url = xhrUrl.get(this);
    if (isGraphql(url)) {
      this.addEventListener('load', () => {
        try {
          const rt = this.responseType;
          if (rt === '' || rt === 'text') emit(url, this.responseText);
          else if (rt === 'json') emit(url, JSON.stringify(this.response));
          else if (rt === 'arraybuffer') emit(url, new TextDecoder().decode(this.response));
          else if (rt === 'blob') this.response.text().then((t) => emit(url, t)).catch(() => {});
        } catch (_) {}
      });
    }
    return origSend.apply(this, arguments);
  };
})();
