importScripts('parse.js');

// Storage layout (chrome.storage.local):
//   capturing: bool
//   state:     { messages, participants, responses }  (see parse.js)
//   summary:   summarize(state), watched by the popup for its live counter
//   saving:    progress of the current/last save, watched by the popup
//   options:   { saveMedia }  (written by the popup)
//
// The worker can be suspended at any time, so the in-memory copy is only a
// cache over storage. All capture mutations go through one promise chain so
// two responses landing together can't overwrite each other's merge.

// 4 parallel media downloads: enough to finish a few hundred files in
// seconds without hammering the CDN into rate-limiting us.
const MEDIA_CONCURRENCY = 4;
// A stalled download is cancelled and recorded as failed, not waited on forever.
const DOWNLOAD_TIMEOUT_MS = 120000;

let cache = null;
let queue = Promise.resolve();
let saveRunning = false;

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

async function persist() {
  await chrome.storage.local.set({ capturing: cache.capturing, state: cache.state, summary: summarize(cache.state) });
}

async function getSaving() {
  const { saving = null } = await chrome.storage.local.get(['saving']);
  // Worker was killed mid-save: storage still says active but nothing runs.
  if (saving && saving.active && !saveRunning) {
    saving.active = false;
    saving.error = 'interrupted, click Save JSON again';
    await chrome.storage.local.set({ saving });
  }
  return saving;
}

async function status() {
  const c = await load();
  return { capturing: c.capturing, ...summarize(c.state), saving: await getSaving() };
}

// ---- downloads ----------------------------------------------------------

const waiters = new Map();
chrome.downloads.onChanged.addListener((d) => {
  const w = waiters.get(d.id);
  if (!w || !d.state) return;
  if (d.state.current === 'complete') w.resolve();
  else if (d.state.current === 'interrupted') w.reject(new Error((d.error && d.error.current) || 'interrupted'));
});

// Start a download and resolve with its final absolute path once complete.
async function downloadAndWait(opts) {
  const id = await chrome.downloads.download(opts);
  try {
    const done = new Promise((resolve, reject) => waiters.set(id, { resolve, reject }));
    // It may already have finished before the waiter was registered.
    const [early] = await chrome.downloads.search({ id });
    if (early && early.state === 'interrupted') throw new Error(early.error || 'interrupted');
    if (!early || early.state !== 'complete') {
      let timer;
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('timed out')), DOWNLOAD_TIMEOUT_MS);
      });
      try {
        await Promise.race([done, timeout]);
      } catch (e) {
        chrome.downloads.cancel(id).catch(() => {});
        throw e;
      } finally {
        clearTimeout(timer);
      }
    }
    const [item] = await chrome.downloads.search({ id });
    return { id, filename: item.filename };
  } finally {
    waiters.delete(id);
  }
}

const basename = (p) => p.split(/[\\/]/).pop();

// The worker has no URL.createObjectURL, and a data: URL is capped at 2 MB,
// so the JSON blob is minted in an offscreen document instead.
async function withBlobUrl(text, fn) {
  try {
    await chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['BLOBS'],
      justification: 'Create a blob URL for the exported JSON file',
    });
  } catch (e) {
    if (!/single offscreen/i.test(String(e))) throw e;
  }
  try {
    const { url } = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'blob', text });
    return await fn(url);
  } finally {
    await chrome.offscreen.closeDocument().catch(() => {});
  }
}

async function saveExport(saveMedia) {
  saveRunning = true;
  // Downloads in flight don't count as worker activity; a cheap API call on
  // a timer keeps the worker from being suspended mid-save.
  const keepAlive = setInterval(() => chrome.runtime.getPlatformInfo(), 20000);
  const saving = { active: true, media: saveMedia, done: 0, total: 0, failed: 0, path: null, error: null, at: Date.now() };
  const progress = () => chrome.storage.local.set({ saving: { ...saving } });
  try {
    await progress();
    const c = await load();
    const data = buildExport(c.state);
    const name = exportFilename(data);
    let jsonPath = name;
    let conflict = 'uniquify';

    if (saveMedia) {
      const folder = name.replace(/\.json$/, '');
      jsonPath = `${folder}/chat.json`;
      // Same folder on a re-save: replace in place so the JSON's relative
      // paths keep pointing at the files next to it.
      conflict = 'overwrite';
      const jobs = attachMedia(data);
      saving.total = jobs.length;
      await progress();
      let next = 0;
      const worker = async () => {
        while (next < jobs.length) {
          const job = jobs[next++];
          try {
            const r = await downloadAndWait({ url: job.url, filename: `${folder}/${job.rel}`, conflictAction: 'overwrite' });
            resolveJob(job, `media/${basename(r.filename)}`, null);
            chrome.downloads.erase({ id: r.id }).catch(() => {}); // keep the download list readable
          } catch (e) {
            saving.failed++;
            resolveJob(job, null, String(e.message || e));
          }
          saving.done++;
          await progress();
        }
      };
      await Promise.all(Array.from({ length: Math.min(MEDIA_CONCURRENCY, jobs.length) }, worker));
      data.media_file_count = jobs.length - saving.failed;
      data.media_failed_count = saving.failed;
    }

    const r = await withBlobUrl(JSON.stringify(data, null, 2), (url) =>
      downloadAndWait({ url, filename: jsonPath, conflictAction: conflict })
    );
    saving.path = saveMedia ? jsonPath.replace(/\/chat\.json$/, '/') : basename(r.filename);
    saving.count = data.message_count;
  } catch (e) {
    saving.error = String(e.message || e);
  } finally {
    clearInterval(keepAlive);
    saving.active = false;
    saveRunning = false;
    await progress();
  }
}

// ---- messages -----------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg && msg.target === 'offscreen') return false;
  const handlers = {
    async capture() {
      const c = await load();
      if (!c.capturing) return;
      const before = JSON.stringify(summarize(c.state));
      ingest(c.state, msg.body, { thread: threadIdFromPath(msg.page) });
      if (JSON.stringify(summarize(c.state)) !== before) await persist();
    },
    async start() {
      const c = await load();
      c.capturing = true;
      c.state = emptyState();
      await persist();
      await chrome.storage.local.remove('saving');
      return status();
    },
    async stop() {
      const c = await load();
      c.capturing = false;
      await persist();
      return status();
    },
    async clear() {
      const c = await load();
      c.capturing = false;
      c.state = emptyState();
      await persist();
      await chrome.storage.local.remove('saving');
      return status();
    },
    // Stop if capturing, then save. Runs outside the queue: a media save can
    // take minutes and status calls must keep answering meanwhile.
    async save() {
      if (saveRunning) return status();
      const c = await load();
      if (c.capturing) {
        c.capturing = false;
        await persist();
      }
      saveExport(!!msg.media);
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
