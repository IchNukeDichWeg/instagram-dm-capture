const $ = (id) => document.getElementById(id);
const send = (type, extra) => chrome.runtime.sendMessage({ type, ...extra });

const fmt = (ms) =>
  ms == null
    ? '-'
    : new Date(ms).toLocaleString(undefined, { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });

function hint(text, isError) {
  $('hint').className = 'hint' + (isError ? ' err' : '');
  $('hint').textContent = text;
}

function render(s) {
  const sv = s.saving;
  const busy = !!(sv && sv.active);
  $('dot').className = 'dot' + (s.capturing ? ' on' : '');
  $('state').textContent = busy ? 'Saving' : s.capturing ? 'Capturing' : 'Idle';
  $('count').textContent = (s.count || 0).toLocaleString();
  $('threads').textContent = s.threads > 1 ? `${s.threads} chats` : '';
  $('oldest').textContent = fmt(s.oldest);
  $('newest').textContent = fmt(s.newest);
  $('responses').textContent = s.responses || 0;
  $('start').hidden = s.capturing || busy;
  $('finish').hidden = !s.capturing;
  $('again').hidden = s.capturing || !s.count;
  for (const id of ['start', 'finish', 'again', 'clear', 'media']) $(id).disabled = busy;

  $('bar').hidden = !(busy && sv.total);
  if (busy && sv.total) {
    $('bar').max = sv.total;
    $('bar').value = sv.done;
  }

  if (busy) {
    hint(sv.total ? `Saving media ${sv.done}/${sv.total}${sv.failed ? `, ${sv.failed} failed` : ''}. You can close this popup.` : 'Saving...');
  } else if (sv && sv.error) {
    hint('Save failed: ' + sv.error, true);
  } else if (sv && sv.path) {
    const media = sv.media ? ` and ${sv.total - sv.failed} files` : '';
    const failed = sv.failed ? ` (${sv.failed} files failed, see "error" in the JSON)` : '';
    hint(`Saved ${(sv.count || 0).toLocaleString()} messages${media} to Downloads/${sv.path}${failed}`, !!sv.failed);
  } else if (s.capturing) {
    hint('Refresh the Instagram chat, then scroll up to load older messages. Click Finish when you have enough.');
  } else {
    hint(s.count ? '' : 'Open the chat on instagram.com, click Start, then refresh the page.');
  }
}

async function refresh() {
  render(await send('status'));
}

const saveNow = async () => render(await send('save', { media: $('media').checked }));

$('start').onclick = async () => render(await send('start'));
$('finish').onclick = saveNow;
$('again').onclick = saveNow;
$('clear').onclick = async () => {
  if (confirm('Discard all captured messages?')) render(await send('clear'));
};
$('media').onchange = () => chrome.storage.local.set({ options: { saveMedia: $('media').checked } });

chrome.storage.onChanged.addListener((changes) => {
  if (changes.summary || changes.capturing || changes.saving) refresh();
});
chrome.storage.local.get(['options']).then(({ options = {} }) => {
  $('media').checked = !!options.saveMedia;
});
refresh();
