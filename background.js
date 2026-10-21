importScripts('parse.js');

// Storage layout (chrome.storage.local):
//   capturing: bool
//   state:     { messages, participants, responses }  (see parse.js)
//   summary:   summarize(state), watched by the popup for its live counter
//
// The worker can be suspended at any time, so the in-memory copy is only a
// cache over storage. All mutations go through one promise chain so two
// responses landing together can't overwrite each other's merge.

let cache = null;
let queue = Promise.resolve();

function run(fn) {
  const p = queue.then(fn);
  queue = p.catch((e) => console.error('[igdm-capture]', e));
  return p;
}

async function load() {
  if (!cache) {
    const { capturing = false, state = emptyState() } = await chrome.storage.local.get(['capturing', 'state']);
    cache = { capturing, state };
  }
  return cache;
}

async function save() {
  await chrome.storage.local.set({ capturing: cache.capturing, state: cache.state, summary: summarize(cache.state) });
}

async function status() {
  const c = await load();
  return { capturing: c.capturing, ...summarize(c.state) };
}

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  const handlers = {
    async capture() {
      const c = await load();
      if (!c.capturing) return;
      const before = c.state.responses;
      ingest(c.state, msg.body);
      if (c.state.responses !== before) await save();
    },
    async start() {
      const c = await load();
      c.capturing = true;
      c.state = emptyState();
      await save();
      return status();
    },
    async stop() {
      const c = await load();
      c.capturing = false;
      await save();
      return status();
    },
    async clear() {
      const c = await load();
      c.capturing = false;
      c.state = emptyState();
      await save();
      return status();
    },
    status,
    async export() {
      const c = await load();
      const data = buildExport(c.state);
      return { data, filename: exportFilename(data) };
    },
  };
  const h = handlers[msg && msg.type];
  if (!h) return false;
  run(h).then(reply, (e) => reply({ error: String(e) }));
  return true;
});
