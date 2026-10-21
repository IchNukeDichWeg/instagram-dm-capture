// node test/test.js  -- parser + background worker. No dependencies.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const P = require('../parse.js');
const F = require('./fixture.js');

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('single JSON body', () => {
  const s = P.emptyState();
  assert.equal(P.ingest(s, JSON.stringify(F.page1)), 2);
  assert.equal(s.responses, 1);
  const m4 = s.messages.m4;
  assert.equal(m4.text, 'four');
  assert.equal(m4.sender_username, 'alice_test');
  assert.equal(m4.timestamp_ms, 1792545134899);
  assert.equal(m4.time, new Date(1792545134899).toISOString());
  assert.deepEqual(m4.reactions, [{ emoji: '❤', sender_id: '1002' }]);
  assert.equal(m4.thread_id, '555');
  assert.equal(m4.content, undefined, 'text messages do not carry raw content');
  assert.deepEqual(s.messages.m3.replied_to, { id: 'm1', sender_id: '1001', text: 'one' });
});

test('overlapping pages dedupe, later capture wins', () => {
  const s = P.emptyState();
  P.ingest(s, JSON.stringify(F.page1));
  assert.equal(P.ingest(s, JSON.stringify(F.page2)), 2, 'only m2 and m1 are new');
  assert.equal(Object.keys(s.messages).length, 4);
  assert.equal(s.messages.m3.replied_to, null, 'page2 copy of m3 overwrote page1 copy');
});

test('non-text content kept raw', () => {
  const s = P.emptyState();
  P.ingest(s, JSON.stringify(F.page2));
  assert.equal(s.messages.m2.type, 'IMAGE');
  assert.equal(s.messages.m2.text, null);
  assert.equal(s.messages.m2.content.image_url, 'https://example.invalid/i.jpg');
});

test('for(;;) prefix and newline-delimited multi-doc body', () => {
  const s = P.emptyState();
  const body = 'for (;;);' + JSON.stringify(F.page1) + '\n' + JSON.stringify({ extensions: { is_final: true } }) + '\n' + JSON.stringify(F.page2);
  assert.equal(P.ingest(s, body), 4);
});

test('SSR __bbox shape found by generic walk', () => {
  const s = P.emptyState();
  assert.equal(P.ingest(s, JSON.stringify(F.ssr)), 1);
  assert.equal(s.messages.m0.thread_id, '555');
});

test('unrelated and garbage bodies are ignored', () => {
  const s = P.emptyState();
  assert.equal(P.ingest(s, JSON.stringify(F.unrelated)), 0);
  assert.equal(P.ingest(s, 'not json at all'), 0);
  assert.equal(s.responses, 0);
});

test('export is sorted oldest-first with participants and filename', () => {
  const s = P.emptyState();
  P.ingest(s, JSON.stringify(F.page1));
  P.ingest(s, JSON.stringify(F.page2));
  const d = P.buildExport(s, new Date('2026-10-21T10:00:00Z'));
  assert.equal(d.message_count, 4);
  assert.equal(d.thread_count, 1);
  const t = d.threads[0];
  assert.deepEqual(t.messages.map((m) => m.id), ['m1', 'm2', 'm3', 'm4']);
  assert.deepEqual(t.participants.map((p) => p.username).sort(), ['alice_test', 'bob_test']);
  assert.equal(t.first_message_at, new Date(1792545087708).toISOString());
  assert.match(P.exportFilename(d), /^instagram-dm-(alice_test_bob_test|bob_test_alice_test)-2026-10-21\.json$/);
  const sum = P.summarize(s);
  assert.equal(sum.oldest, 1792545087708);
  assert.equal(sum.newest, 1792545134899);
});

// background.js in a vm with a fake chrome.* so the real handler code runs.
function loadBackground() {
  const store = {};
  let listener;
  const chrome = {
    storage: {
      local: {
        async get(keys) {
          const out = {};
          for (const k of keys) if (k in store) out[k] = structuredClone(store[k]);
          return out;
        },
        async set(obj) {
          await new Promise((r) => setTimeout(r, 1)); // make writes interleave if unserialized
          Object.assign(store, structuredClone(obj));
        },
      },
    },
    runtime: { onMessage: { addListener: (fn) => (listener = fn) } },
  };
  const ctx = { chrome, console, structuredClone, setTimeout };
  ctx.importScripts = (f) => vm.runInContext(fs.readFileSync(path.join(__dirname, '..', f), 'utf8'), ctx);
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8'), ctx);
  const send = (msg) =>
    new Promise((resolve) => {
      const async = listener(msg, {}, resolve);
      if (!async) resolve(undefined);
    });
  return { send, store };
}

test('background: idle ignores traffic, start/capture/stop/export', async () => {
  const bg = loadBackground();
  await bg.send({ type: 'capture', body: JSON.stringify(F.page1) });
  assert.equal((await bg.send({ type: 'status' })).count, 0, 'not capturing yet');

  assert.equal((await bg.send({ type: 'start' })).capturing, true);
  // Fire both pages without awaiting: the queue must serialize the merges.
  const a = bg.send({ type: 'capture', body: JSON.stringify(F.page1) });
  const b = bg.send({ type: 'capture', body: JSON.stringify(F.page2) });
  await Promise.all([a, b]);
  const st = await bg.send({ type: 'status' });
  assert.equal(st.count, 4);
  assert.equal(st.responses, 2);
  assert.equal(bg.store.summary.count, 4, 'summary persisted for the popup');

  assert.equal((await bg.send({ type: 'stop' })).capturing, false);
  await bg.send({ type: 'capture', body: JSON.stringify(F.ssr) });
  assert.equal((await bg.send({ type: 'status' })).count, 4, 'stopped capture ignores traffic');

  const ex = await bg.send({ type: 'export' });
  assert.equal(ex.data.message_count, 4);
  assert.match(ex.filename, /\.json$/);

  await bg.send({ type: 'start' });
  assert.equal((await bg.send({ type: 'status' })).count, 0, 'start begins a fresh capture');
});

test('background: state survives worker restart', async () => {
  const bg = loadBackground();
  await bg.send({ type: 'start' });
  await bg.send({ type: 'capture', body: JSON.stringify(F.page1) });
  // New worker instance over the same storage (service worker was suspended).
  const bg2 = loadBackground();
  Object.assign(bg2.store, bg.store);
  const st = await bg2.send({ type: 'status' });
  assert.equal(st.capturing, true);
  assert.equal(st.count, 2);
  await bg2.send({ type: 'capture', body: JSON.stringify(F.page2) });
  assert.equal((await bg2.send({ type: 'status' })).count, 4);
});

(async () => {
  let failed = 0;
  for (const t of tests) {
    try {
      await t.fn();
      console.log('ok   ' + t.name);
    } catch (e) {
      failed++;
      console.log('FAIL ' + t.name + '\n     ' + e.message);
    }
  }
  console.log(`\n${tests.length - failed}/${tests.length} passed`);
  process.exit(failed ? 1 : 0);
})();
