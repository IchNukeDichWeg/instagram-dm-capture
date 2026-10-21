// Only job: turn the export text into a blob URL the worker can download.
// The blob dies with this document, which the worker closes after the save.
chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (!msg || msg.target !== 'offscreen' || msg.type !== 'blob') return false;
  reply({ url: URL.createObjectURL(new Blob([msg.text], { type: 'application/json' })) });
  return false;
});
