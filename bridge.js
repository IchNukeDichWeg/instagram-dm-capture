// Isolated-world content script: relays bodies from hook.js (which has no
// chrome.* access) to the background worker. The worker decides whether a
// capture is running, so nothing here depends on async state at page load.
(() => {
  const TAG = 'igdm-capture';

  function send(body) {
    try {
      chrome.runtime.sendMessage({ type: 'capture', body }).catch(() => {});
    } catch (_) {
      // Extension reloaded while the tab stayed open: context is gone.
    }
  }

  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || e.data.source !== TAG) return;
    send(e.data.body);
  });

  // The first page of a thread is often server-rendered into inline JSON
  // script tags instead of fetched, so a refresh would miss it via XHR alone.
  document.addEventListener('DOMContentLoaded', () => {
    for (const s of document.querySelectorAll('script[type="application/json"]')) {
      const t = s.textContent;
      if (t && t.includes('slide_messages')) send(t);
    }
  });
})();
