// node test/e2e-test.js [--ext DIR] [--screenshots DIR]
//
// Loads the real extension in Chrome for Testing,
// points www.instagram.com and a fake CDN host at a local HTTPS server, then
// drives start -> page load -> save (with and without media) and checks the
// files that land on disk.
//
// Branded Google Chrome ignores --load-extension, so this needs Chrome for
// Testing; it uses the newest one in Puppeteer's cache
// (npx @puppeteer/browsers install chrome@stable puts one there).
//
//   --ext DIR          test an unpacked build (e.g. the unzipped release zip)
//                      instead of the source folder
//   --screenshots DIR  write popup-light.png / popup-dark.png of the popup
//                      mid-capture, as used in the README
const assert = require('node:assert/strict');
const https = require('node:https');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');
const F = require('./fixture.js');

function flag(name) {
  const i = process.argv.indexOf(name);
  if (i === -1) return null;
  const v = process.argv[i + 1];
  if (!v || v.startsWith('--')) throw new Error(name + ' needs a value');
  return path.resolve(v);
}
const EXT = flag('--ext') || path.resolve(__dirname, '..');
const SHOTS = flag('--screenshots');
if (!fs.existsSync(path.join(EXT, 'manifest.json'))) throw new Error('no manifest.json in ' + EXT);
const IG_URL = 'https://www.instagram.com/direct/t/555/';

function findChrome() {
  const root = path.join(os.homedir(), '.cache', 'puppeteer', 'chrome');
  const dirs = fs.existsSync(root) ? fs.readdirSync(root).filter((d) => /^mac_arm-|^mac-|^linux-/.test(d)) : [];
  const ver = (d) => d.split('-')[1].split('.').map(Number);
  dirs.sort((a, b) => {
    const [x, y] = [ver(a), ver(b)];
    for (let i = 0; i < 4; i++) if (x[i] !== y[i]) return x[i] - y[i];
    return 0;
  });
  for (const d of dirs.reverse()) {
    for (const rel of [
      'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
      'chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
      'chrome-linux64/chrome',
    ]) {
      const p = path.join(root, d, rel);
      if (fs.existsSync(p)) return p;
    }
  }
  throw new Error('No Chrome for Testing found under ' + root);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'igdm-e2e-'));
const downloads = path.join(tmp, 'downloads');
const profile = path.join(tmp, 'profile');
fs.mkdirSync(downloads);
fs.mkdirSync(path.join(profile, 'Default'), { recursive: true });
fs.writeFileSync(
  path.join(profile, 'Default', 'Preferences'),
  JSON.stringify({ download: { default_directory: downloads, prompt_for_download: false } })
);
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=test',
  '-keyout', path.join(tmp, 'key.pem'), '-out', path.join(tmp, 'cert.pem')], { stdio: 'ignore' });

// ---- fake instagram + CDN ------------------------------------------------

const mediaHits = [];
const ssrJson = JSON.stringify(F.ssr).replace(/</g, '\\u003c');
const igPage = `<!doctype html><title>loading</title>
<script type="application/json">${ssrJson}</script>
<script>
(async () => {
  await fetch('/api/graphql?p=4', { method: 'POST' }).then((r) => r.text()); // inbox preload of every chat
  await fetch('/api/graphql?p=1', { method: 'POST' }).then((r) => r.text());
  await new Promise((r) => { const x = new XMLHttpRequest(); x.open('POST', '/api/graphql?p=2'); x.onloadend = r; x.send(); });
  await fetch('/graphql/query?p=3', { method: 'POST' }).then((r) => r.text());
  document.title = 'done';
})();
</script>`;

const server = https.createServer(
  { key: fs.readFileSync(path.join(tmp, 'key.pem')), cert: fs.readFileSync(path.join(tmp, 'cert.pem')) },
  (req, res) => {
    const u = new URL(req.url, 'https://x');
    if (req.headers.host.startsWith('scontent-test.cdninstagram.com')) {
      mediaHits.push(req.url);
      const name = u.pathname.split('/').pop();
      if (name === 'missing.jpg') return res.writeHead(404).end();
      res.setHeader('content-type', name.endsWith('.mp4') ? 'video/mp4' : 'image/jpeg');
      return res.end('BYTES:' + name);
    }
    if (u.pathname.startsWith('/direct/')) return res.setHeader('content-type', 'text/html').end(igPage);
    const body = { 1: F.page1, 2: F.page2, 3: F.mediaPage, 4: F.preload }[u.searchParams.get('p')] || F.unrelated;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(body));
  }
);

// ---- minimal CDP client ----------------------------------------------------

function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? reject(new Error(m.error.message)) : resolve(m.result);
    }
  };
  const send = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const msg = { id: ++id, method, params };
      if (sessionId) msg.sessionId = sessionId;
      pending.set(msg.id, { resolve, reject });
      ws.send(JSON.stringify(msg));
    });
  return new Promise((resolve) => (ws.onopen = () => resolve({ send, close: () => ws.close() })));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, what, ms = 20000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out waiting for ' + what);
    await sleep(100);
  }
}

async function main() {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const chromePath = findChrome();
  const chrome = spawn(chromePath, [
    '--headless=new',
    `--user-data-dir=${profile}`,
    '--remote-debugging-port=0',
    `--load-extension=${EXT}`,
    `--disable-extensions-except=${EXT}`,
    '--ignore-certificate-errors',
    `--host-resolver-rules=MAP www.instagram.com 127.0.0.1:${port}, MAP scontent-test.cdninstagram.com 127.0.0.1:${port}`,
    '--no-first-run',
    '--no-default-browser-check',
    'about:blank',
  ], { stdio: 'ignore' });

  try {
    const portFile = path.join(profile, 'DevToolsActivePort');
    const [dport, wsPath] = (await waitFor(() => fs.existsSync(portFile) && fs.readFileSync(portFile, 'utf8').trim().split('\n'), 'devtools')) || [];
    const c = await cdp(`ws://127.0.0.1:${dport}${wsPath}`);

    // Several component extensions also run a background.js worker; ours is
    // the one whose manifest carries our name.
    const extId = await waitFor(async () => {
      const { targetInfos } = await c.send('Target.getTargets');
      for (const t of targetInfos.filter((t) => t.type === 'service_worker' && t.url.startsWith('chrome-extension://'))) {
        const { sessionId } = await c.send('Target.attachToTarget', { targetId: t.targetId, flatten: true });
        const r = await c.send('Runtime.evaluate', { expression: 'chrome.runtime.getManifest().name', returnByValue: true }, sessionId).catch(() => null);
        await c.send('Target.detachFromTarget', { sessionId }).catch(() => {});
        if (r && r.result && r.result.value === 'Instagram DM Capture') return new URL(t.url).host;
      }
      return null;
    }, 'extension service worker');

    const open = async (url) => {
      const { targetId } = await c.send('Target.createTarget', { url });
      const { sessionId } = await c.send('Target.attachToTarget', { targetId, flatten: true });
      return sessionId;
    };
    const evaluate = async (sid, expression) => {
      const r = await c.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sid);
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
      return r.result.value;
    };

    const popup = await open(`chrome-extension://${extId}/popup.html`);
    await waitFor(() => evaluate(popup, 'location.protocol === "chrome-extension:" && document.readyState === "complete"').catch(() => false), 'popup');
    const msg = (m) => evaluate(popup, `chrome.runtime.sendMessage(${JSON.stringify(m)})`);

    // Idle: page traffic must not be recorded.
    const idleTab = await open(IG_URL);
    await waitFor(() => evaluate(idleTab, 'document.title === "done"'), 'idle page load');
    await sleep(300);
    assert.equal((await msg({ type: 'status' })).count, 0, 'nothing captured before Start');

    assert.equal((await msg({ type: 'start' })).capturing, true);
    await evaluate(idleTab, 'location.reload()');
    await sleep(200);
    await waitFor(() => evaluate(idleTab, 'document.title === "done"'), 'page reload');
    const st = await waitFor(async () => {
      const s = await msg({ type: 'status' });
      return s.count === 7 && s;
    }, '7 captured messages (ssr m0 + pages m1..m6)');
    assert.equal(st.responses, 5, 'ssr blob + 3 thread pages + the preload (it carries m4 of this chat)');
    assert.equal(st.current, '555');
    assert.deepEqual(st.currentNames, ['alice_test', 'bob_test']);
    assert.equal(st.skipped, 3, 'preloaded messages of chats 777 and 888 skipped');
    assert.equal(st.skippedChats, 2);
    console.log('ok   capture: hook + bridge + worker saw ssr, fetch, xhr, /graphql/query (7 messages)');
    console.log('ok   open-chat filter: inbox preload of 2 other chats skipped (3 messages)');

    if (SHOTS) {
      fs.mkdirSync(SHOTS, { recursive: true });
      await evaluate(popup, 'document.getElementById("media").checked = true');
      const h = await evaluate(popup, 'document.documentElement.scrollHeight');
      await c.send('Emulation.setDeviceMetricsOverride', { width: 298, height: h, deviceScaleFactor: 2, mobile: false }, popup);
      for (const scheme of ['light', 'dark']) {
        await c.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] }, popup);
        await sleep(150);
        const { data: png } = await c.send('Page.captureScreenshot', { format: 'png' }, popup);
        const out = path.join(SHOTS, `popup-${scheme}.png`);
        fs.writeFileSync(out, Buffer.from(png, 'base64'));
        console.log('     screenshot: ' + out);
      }
      await c.send('Emulation.clearDeviceMetricsOverride', {}, popup);
    }

    // The inbox page itself (no chat open) adds nothing.
    const inbox = await open('https://www.instagram.com/direct/inbox/');
    await waitFor(() => evaluate(inbox, 'document.title === "done"'), 'inbox load');
    await sleep(300);
    const sti = await msg({ type: 'status' });
    assert.equal(sti.count, 7, 'inbox page captures nothing');
    assert.equal(sti.current, null);
    await c.send('Target.closeTarget', { targetId: (await c.send('Target.getTargets')).targetInfos.find((t) => t.url.includes('/direct/inbox/')).targetId });
    console.log('ok   open-chat filter: inbox page with no chat open captures nothing');

    // Save with media.
    await msg({ type: 'save', media: true });
    const sv = await waitFor(async () => {
      const s = (await msg({ type: 'status' })).saving;
      return s && !s.active && s;
    }, 'media save', 60000);
    assert.equal(sv.error, null, 'save error: ' + sv.error);
    assert.equal(sv.total, 5);
    assert.equal(sv.failed, 1);

    const folder = path.join(downloads, sv.path);
    const data = JSON.parse(fs.readFileSync(path.join(folder, 'chat.json'), 'utf8'));
    const media = fs.readdirSync(path.join(folder, 'media')).sort();
    assert.deepEqual(media, ['img_m2.jpg', 'pic_alice_test.jpg', 'pic_bob_test.jpg', 'vid_m5.mp4']);
    assert.equal(fs.readFileSync(path.join(folder, 'media', 'vid_m5.mp4'), 'utf8'), 'BYTES:vid_m5.mp4');
    const msgs = Object.fromEntries(data.threads[0].messages.map((m) => [m.id, m]));
    assert.equal(data.message_count, 7);
    assert.equal(msgs.m2.media[0].file, 'media/img_m2.jpg');
    assert.equal(msgs.m5.media[0].file, 'media/vid_m5.mp4');
    assert.equal(msgs.m6.media[0].file, null);
    assert.ok(msgs.m6.media[0].error, 'failed download records its error');
    assert.equal(data.media_file_count, 4);
    assert.equal(data.media_failed_count, 1);
    for (const p of data.threads[0].participants) assert.ok(fs.existsSync(path.join(folder, p.profile_pic_file)));
    for (const m of Object.values(msgs)) for (const x of m.media || []) if (x.file) assert.ok(fs.existsSync(path.join(folder, x.file)));
    assert.ok(mediaHits.some((h) => h.includes('img_m2.jpg?stp=s1080')), 'largest variant fetched');
    assert.ok(!mediaHits.some((h) => h.includes('stp=s320')), 'smaller variant skipped');
    assert.ok(!mediaHits.some((h) => h.includes('not-media')), 'non-CDN link skipped');
    console.log(`ok   media save: ${sv.path}chat.json + ${media.length} files, 404 recorded as error (${msgs.m6.media[0].error})`);

    // Re-save into the same folder: overwritten in place, not "chat (1).json".
    await msg({ type: 'save', media: true });
    await waitFor(async () => {
      const s = (await msg({ type: 'status' })).saving;
      return s && !s.active && s.path && s;
    }, 'second media save', 60000);
    assert.deepEqual(fs.readdirSync(folder).sort(), ['chat.json', 'media']);
    console.log('ok   re-save overwrites the same folder');

    // Save without media: one standalone file, no media fields.
    await msg({ type: 'save', media: false });
    const sv2 = await waitFor(async () => {
      const s = (await msg({ type: 'status' })).saving;
      return s && !s.active && s.media === false && s.path && s;
    }, 'plain save', 30000);
    const plain = JSON.parse(fs.readFileSync(path.join(downloads, sv2.path), 'utf8'));
    assert.equal(plain.message_count, 7);
    assert.equal(plain.threads[0].messages.find((m) => m.id === 'm2').media, undefined);
    assert.match(sv2.path, /^instagram-dm-alice_test_bob_test-\d{4}-\d{2}-\d{2}\.json$/);
    console.log('ok   plain save: ' + sv2.path);

    // Switching chats in-app (pushState, no reload) captures the new chat:
    // the filter follows the URL at the time each response arrives.
    await msg({ type: 'start' });
    await evaluate(idleTab, `history.pushState({}, '', '/direct/t/777/'); fetch('/api/graphql?p=4', { method: 'POST' }).then((r) => r.text())`);
    const sw2 = await waitFor(async () => {
      const s = await msg({ type: 'status' });
      return s.count === 2 && s;
    }, 'chat 777 after switching');
    assert.equal(sw2.current, '777');
    assert.equal(sw2.skipped, 2, 'm4 (555) and y1 (888) skipped');
    console.log('ok   open-chat filter: switching to another chat captures that chat only');

    c.close();
  } finally {
    // Wait for Chrome to actually exit: it keeps writing its profile for a
    // moment after the signal, which made the cleanup throw ENOTEMPTY and
    // that error replaced the real test result. Cleanup can't fail the run.
    const exited = new Promise((r) => chrome.once('exit', r));
    chrome.kill();
    await Promise.race([exited, sleep(5000)]);
    server.close();
    try {
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch (e) {
      console.log('     (temp dir not removed: ' + e.code + ')');
    }
  }
}

main().then(
  () => console.log('\ne2e passed'),
  (e) => {
    console.log('FAIL ' + e.message);
    process.exitCode = 1;
  }
);
