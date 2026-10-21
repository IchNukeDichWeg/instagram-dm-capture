// node scripts/render-icons.js  -- renders icons/icon.svg to the PNG sizes
// Chrome wants (16/32/48/128) with headless Google Chrome, transparent
// background. Each size is rasterised from the vector, not downscaled.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const SIZES = [16, 32, 48, 128];
const dir = path.resolve(__dirname, '..', 'icons');
const svg = fs.readFileSync(path.join(dir, 'icon.svg'), 'utf8');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'igdm-icons-'));
try {
  for (const size of SIZES) {
    const html = path.join(tmp, `${size}.html`);
    fs.writeFileSync(html, `<!doctype html><style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${svg}`);
    const out = path.join(dir, `icon${size}.png`);
    execFileSync(CHROME, [
      '--headless=new', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1',
      '--default-background-color=00000000', `--user-data-dir=${path.join(tmp, 'profile')}`,
      `--window-size=${size},${size}`, `--screenshot=${out}`, 'file://' + html,
    ], { stdio: 'ignore' });
    console.log(`icon${size}.png  ${fs.statSync(out).size} bytes`);
  }
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
