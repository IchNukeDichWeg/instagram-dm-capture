// node test/hook-test.js  -- runs hook.js in real headless Chrome against a
// local fake /api/graphql and checks what it posts to the bridge.
// Needs Google Chrome; set CHROME below if it lives elsewhere.
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const F = require('./fixture.js');

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const hook = fs.readFileSync(path.join(__dirname, '..', 'hook.js'), 'utf8');

const page = `<!doctype html><script>${hook}</script>
<script>
const got = [];
addEventListener('message', (e) => { if (e.data && e.data.source === 'igdm-capture') got.push(e.data.url.replace(location.origin, '')); });
function xhr(url, type) {
  return new Promise((r) => { const x = new XMLHttpRequest(); x.open('POST', url); x.responseType = type;
    x.onloadend = r; x.send('q=1'); });
}
(async () => {
  await fetch('/api/graphql?via=fetch', { method: 'POST' }).then((r) => r.json()); // page still reads its own body
  await fetch(new Request('/graphql/query?via=fetch-request', { method: 'POST' }));
  await xhr('/api/graphql?via=xhr-text', '');
  await xhr('/api/graphql?via=xhr-json', 'json');
  await xhr('/api/graphql?via=xhr-arraybuffer', 'arraybuffer');
  await xhr('/api/graphql?via=xhr-blob', 'blob');
  await fetch('/api/graphql?via=unrelated', { method: 'POST' });
  await fetch('/other?via=not-graphql', { method: 'POST' });
  await new Promise((r) => setTimeout(r, 200));
  document.body.innerHTML = '<pre id=out>' + JSON.stringify(got.sort()) + '</pre>';
})();
</script>`;

const server = http.createServer((req, res) => {
  if (req.url === '/') return res.end(page);
  const body = req.url.includes('unrelated') ? JSON.stringify(F.unrelated) : JSON.stringify(F.page1);
  res.setHeader('content-type', 'application/json');
  res.end(body);
});

server.listen(0, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${server.address().port}/`;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'igdm-hook-'));
  execFile(
    CHROME,
    ['--headless=new', '--disable-gpu', `--user-data-dir=${profile}`, '--virtual-time-budget=10000', '--dump-dom', url],
    { timeout: 60000 },
    (err, stdout) => {
      server.close();
      fs.rmSync(profile, { recursive: true, force: true });
      if (err) throw err;
      const m = stdout.match(/<pre id="out">(.*?)<\/pre>/);
      assert.ok(m, 'page did not finish:\n' + stdout.slice(0, 500));
      const got = JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&'));
      const want = ['fetch', 'fetch-request', 'xhr-arraybuffer', 'xhr-blob', 'xhr-json', 'xhr-text'];
      assert.deepEqual(got.map((u) => u.split('via=')[1]).sort(), want);
      console.log('ok   hook captured: ' + want.join(', '));
      console.log('ok   hook skipped: unrelated graphql body, non-graphql url');
    }
  );
});
