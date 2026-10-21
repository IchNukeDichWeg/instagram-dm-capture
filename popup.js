const $ = (id) => document.getElementById(id);
const send = (type) => chrome.runtime.sendMessage({ type });

const fmt = (ms) =>
  ms == null
    ? '-'
    : new Date(ms).toLocaleString(undefined, { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });

function render(s) {
  $('dot').className = 'dot' + (s.capturing ? ' on' : '');
  $('state').textContent = s.capturing ? 'Capturing' : 'Idle';
  $('count').textContent = (s.count || 0).toLocaleString();
  $('threads').textContent = s.threads > 1 ? `${s.threads} chats` : '';
  $('oldest').textContent = fmt(s.oldest);
  $('newest').textContent = fmt(s.newest);
  $('responses').textContent = s.responses || 0;
  $('start').hidden = s.capturing;
  $('finish').hidden = !s.capturing;
  $('again').hidden = s.capturing || !s.count;
  $('hint').className = 'hint';
  $('hint').textContent = s.capturing
    ? 'Refresh the Instagram chat, then scroll up to load older messages. Click Finish when you have enough.'
    : s.count
      ? ''
      : 'Open the chat on instagram.com, click Start, then refresh the page.';
}

async function refresh() {
  render(await send('status'));
}

async function download() {
  const { data, filename, error } = await send('export');
  if (error) throw new Error(error);
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  // No saveAs dialog: it steals focus, which closes the popup and revokes the
  // blob URL before Chrome has read it. Goes straight to ~/Downloads.
  await chrome.downloads.download({ url, filename, conflictAction: 'uniquify' });
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  return { filename, count: data.message_count };
}

async function saveAndReport() {
  try {
    const { filename, count } = await download();
    $('hint').textContent = `Saved ${count.toLocaleString()} messages to Downloads/${filename}`;
  } catch (e) {
    $('hint').className = 'hint err';
    $('hint').textContent = 'Save failed: ' + e.message;
  }
}

$('start').onclick = async () => render(await send('start'));
$('finish').onclick = async () => {
  render(await send('stop'));
  await saveAndReport();
};
$('again').onclick = saveAndReport;
$('clear').onclick = async () => {
  if (confirm('Discard all captured messages?')) render(await send('clear'));
};

chrome.storage.onChanged.addListener((changes) => {
  if (changes.summary || changes.capturing) refresh();
});
refresh();
