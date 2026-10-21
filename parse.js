// Pure parsing/merging logic, shared by background.js (importScripts) and
// the node tests (require). No chrome.* calls in here.

// A GraphQL body can be one JSON document, or several newline-separated ones
// (incremental delivery, `is_final`), optionally behind a `for (;;);` guard.
function parseBodies(text) {
  text = String(text).replace(/^\s*for\s*\(;;\);/, '');
  try {
    return [JSON.parse(text)];
  } catch (_) {}
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    const s = line.trim().replace(/^for\s*\(;;\);/, '');
    if (!s) continue;
    try {
      out.push(JSON.parse(s));
    } catch (_) {}
  }
  return out;
}

// The chat open in the tab: instagram.com/direct/t/<id>/. Null on the inbox
// or any other page.
function threadIdFromPath(pathname) {
  const m = /\/direct\/t\/([^/?#]+)/.exec(String(pathname || ''));
  return m ? decodeURIComponent(m[1]) : null;
}

// Every id-like scalar on the object holding a thread's messages (`id`,
// `thread_fbid`, `thread_key`, ...). The URL's chat id is matched against
// this set rather than one assumed field name.
function threadIdsOf(container) {
  const ids = new Set();
  for (const k in container) {
    const v = container[k];
    if ((typeof v === 'string' || typeof v === 'number') && /id|key/i.test(k)) ids.add(String(v));
  }
  return ids;
}

// Walk any JSON shape and yield every `slide_messages.edges` list with the id
// of the object holding it (the thread). Generic on purpose: the same data
// shows up under different query names and inside SSR `__bbox` wrappers.
function findMessageNodes(root) {
  const found = [];
  const stack = [root];
  while (stack.length) {
    const v = stack.pop();
    if (!v || typeof v !== 'object') continue;
    if (Array.isArray(v)) {
      for (const x of v) stack.push(x);
      continue;
    }
    const sm = v.slide_messages;
    if (sm && Array.isArray(sm.edges)) {
      const threadIds = threadIdsOf(v);
      for (const e of sm.edges) if (e && e.node) found.push({ node: e.node, threadId: v.id || null, threadIds });
    }
    for (const k in v) if (k !== 'slide_messages') stack.push(v[k]);
  }
  return found;
}

function textOf(node) {
  if (!node) return null;
  return node.text_body ?? node.content?.text_body ?? null;
}

function normalizeMessage(node, threadId) {
  const ts = Number(node.timestamp_ms);
  const sender = node.sender || {};
  const ud = sender.user_dict || {};
  const msg = {
    id: node.message_id || node.id,
    thread_id: node.thread_fbid || threadId || null,
    timestamp_ms: ts,
    time: Number.isFinite(ts) ? new Date(ts).toISOString() : null,
    sender_id: node.sender_fbid || sender.id || null,
    sender_username: ud.username || null,
    sender_name: sender.name || ud.full_name || null,
    type: node.content_type || node.content?.__typename || null,
    text: textOf(node),
    reactions: (node.reactions || []).map((r) => ({ emoji: r.reaction, sender_id: r.sender_fbid })),
    replied_to_message_id: node.replied_to_message_id || null,
    replied_to: null,
    is_forwarded: !!node.igd_is_forwarded,
    is_pinned: !!node.is_pinned,
    is_unsent: node.tombstone_reason != null,
    edit_history: node.slide_edit_history || [],
  };
  const rt = node.replied_to_message;
  if (rt && typeof rt === 'object') {
    msg.replied_to = {
      id: rt.message_id || rt.id || node.replied_to_message_id || null,
      sender_id: rt.sender_fbid || null,
      text: textOf(rt),
    };
  }
  // Non-text content (photos, reels, voice, links, ...) has no stable shape
  // across types; keep it raw so nothing is lost.
  if (node.content && node.content.__typename !== 'SlideMessageText') msg.content = node.content;
  return msg;
}

function participantOf(node) {
  const s = node.sender;
  if (!s || !s.id) return null;
  const ud = s.user_dict || {};
  return {
    id: s.id,
    igid: s.igid || ud.id || null,
    username: ud.username || null,
    name: s.name || ud.full_name || null,
    profile_pic_url: ud.profile_pic_url || null,
  };
}

function emptyState() {
  return { messages: {}, participants: {}, responses: 0, skippedIds: {}, current: null, urlThreads: {} };
}

// Merge one response body into state in place. Returns how many messages
// were new. Re-seen messages are overwritten so reaction/edit updates win.
//
// opts.thread filters to one chat: the id from the tab's /direct/t/<id>/ URL
// when the response arrived. Instagram preloads ~20 messages of every chat in
// the inbox list, and those must not end up in the capture. A null thread
// (inbox, profile page, ...) keeps nothing. Without opts.thread nothing is
// filtered.
function ingest(state, text, opts = {}) {
  const filter = 'thread' in opts;
  const only = filter && opts.thread != null ? String(opts.thread) : null;
  // id -> chat, so a preview seen again on every refresh is counted once.
  state.skippedIds = state.skippedIds || {};
  state.urlThreads = state.urlThreads || {};
  if (filter) state.current = only;
  let added = 0;
  let hit = false;
  for (const doc of parseBodies(text)) {
    for (const { node, threadId, threadIds } of findMessageNodes(doc)) {
      const msg = normalizeMessage(node, threadId);
      if (!msg.id) continue;
      if (filter) {
        const ids = new Set(threadIds);
        if (node.thread_fbid != null) ids.add(String(node.thread_fbid));
        if (only === null || !ids.has(only)) {
          if (!state.messages[msg.id]) state.skippedIds[msg.id] = msg.thread_id || '?';
          continue;
        }
        state.urlThreads[only] = msg.thread_id;
        delete state.skippedIds[msg.id];
      }
      hit = true;
      if (!state.messages[msg.id]) added++;
      state.messages[msg.id] = msg;
      const p = participantOf(node);
      if (p) state.participants[p.id] = p;
    }
  }
  if (hit) state.responses++;
  return added;
}

function summarize(state) {
  const msgs = Object.values(state.messages);
  const threads = new Set(msgs.map((m) => m.thread_id));
  let oldest = null;
  let newest = null;
  for (const m of msgs) {
    if (!Number.isFinite(m.timestamp_ms)) continue;
    if (oldest === null || m.timestamp_ms < oldest) oldest = m.timestamp_ms;
    if (newest === null || m.timestamp_ms > newest) newest = m.timestamp_ms;
  }
  // The open chat as the popup shows it: usernames of whoever has written in
  // it so far, or just its id before any of its messages arrived.
  const current = state.current || null;
  const key = current && state.urlThreads ? state.urlThreads[current] : null;
  const names = new Set();
  if (key) for (const m of msgs) if (m.thread_id === key && m.sender_username) names.add(m.sender_username);
  return {
    count: msgs.length,
    threads: threads.size,
    responses: state.responses,
    oldest,
    newest,
    skipped: Object.keys(state.skippedIds || {}).length,
    skippedChats: new Set(Object.values(state.skippedIds || {})).size,
    current,
    currentNames: [...names].sort(),
  };
}

// Returns a detached copy: callers (attachMedia) annotate it, and that must
// not leak back into the stored capture.
function buildExport(state, exportedAt = new Date()) {
  state = structuredClone(state);
  const byThread = new Map();
  for (const m of Object.values(state.messages)) {
    if (!byThread.has(m.thread_id)) byThread.set(m.thread_id, []);
    byThread.get(m.thread_id).push(m);
  }
  const threads = [];
  for (const [threadId, msgs] of byThread) {
    msgs.sort((a, b) => a.timestamp_ms - b.timestamp_ms);
    const ids = [...new Set(msgs.map((m) => m.sender_id))];
    threads.push({
      thread_id: threadId,
      participants: ids.map((id) => state.participants[id] || { id }),
      message_count: msgs.length,
      first_message_at: msgs[0]?.time ?? null,
      last_message_at: msgs[msgs.length - 1]?.time ?? null,
      messages: msgs,
    });
  }
  threads.sort((a, b) => b.message_count - a.message_count);
  return {
    exported_at: exportedAt.toISOString(),
    source: 'instagram.com graphql slide_messages',
    message_count: threads.reduce((n, t) => n + t.message_count, 0),
    thread_count: threads.length,
    threads,
  };
}

function exportFilename(data) {
  // Local calendar date, so a late-night export is named for the day it was made.
  const d = new Date(data.exported_at);
  const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  if (data.threads.length !== 1) return `instagram-dm-${data.threads.length}threads-${date}.json`;
  const names = data.threads[0].participants
    .map((p) => p.username || p.id)
    .filter(Boolean)
    .join('_')
    .replace(/[^A-Za-z0-9._-]/g, '')
    .slice(0, 80);
  return `instagram-dm-${names || data.threads[0].thread_id}-${date}.json`;
}

// Only Instagram/Facebook CDN hosts count as media. Shared-link messages also
// carry plain web URLs, and those are pages, not files.
const MEDIA_HOST = /(^|\.)(cdninstagram\.com|fbcdn\.net)$/;

function isMediaUrl(s) {
  if (typeof s !== 'string' || !/^https?:\/\//.test(s)) return false;
  try {
    return MEDIA_HOST.test(new URL(s).hostname);
  } catch (_) {
    return false;
  }
}

// Every CDN URL inside a raw `content` object, with the JSON path it came
// from. A list of sized variants of one asset ({url, width}, ...) is reduced
// to its largest entry, so a photo is saved once, not once per resolution.
function collectMediaUrls(value, path = 'content', out = []) {
  if (typeof value === 'string') {
    if (isMediaUrl(value)) out.push({ path, url: value });
  } else if (Array.isArray(value)) {
    const sized =
      value.length > 1 &&
      value.every((x) => x && typeof x === 'object' && typeof x.url === 'string' && Number.isFinite(Number(x.width)));
    if (sized) {
      let best = 0;
      value.forEach((x, i) => {
        if (Number(x.width) > Number(value[best].width)) best = i;
      });
      collectMediaUrls(value[best], `${path}[${best}]`, out);
    } else {
      value.forEach((x, i) => collectMediaUrls(x, `${path}[${i}]`, out));
    }
  } else if (value && typeof value === 'object') {
    for (const k in value) collectMediaUrls(value[k], `${path}.${k}`, out);
  }
  return out;
}

// CDN basenames are unique per asset (sizes of one asset share a basename,
// differing only in the `stp` query), so the basename is the dedupe key.
function mediaFileName(url) {
  let base = '';
  try {
    base = decodeURIComponent(new URL(url).pathname.split('/').pop() || '');
  } catch (_) {}
  base = base.replace(/[^A-Za-z0-9._-]/g, '_').slice(-120);
  if (!base || base === '_') {
    let h = 0;
    for (const ch of url) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    base = 'file_' + h.toString(16);
  }
  return base;
}

// Annotate an export (from buildExport) with planned local paths and return
// the download jobs. Each job lists the objects whose `file` field the
// caller sets once the download's outcome is known.
//   message.media = [{ path, url, file }]   participant.profile_pic_file
function attachMedia(data, dir = 'media') {
  const jobs = new Map();
  const plan = (url, ref, key) => {
    const name = mediaFileName(url);
    if (!jobs.has(name)) jobs.set(name, { url, name, rel: `${dir}/${name}`, refs: [] });
    jobs.get(name).refs.push({ obj: ref, key });
  };
  for (const t of data.threads) {
    for (const p of t.participants) if (p.profile_pic_url) plan(p.profile_pic_url, p, 'profile_pic_file');
    for (const m of t.messages) {
      if (!m.content) continue;
      const found = collectMediaUrls(m.content);
      if (!found.length) continue;
      m.media = found.map((f) => ({ path: f.path, url: f.url, file: null }));
      m.media.forEach((entry) => plan(entry.url, entry, 'file'));
    }
  }
  return [...jobs.values()];
}

// Write one job's outcome into every object that referenced it.
function resolveJob(job, rel, error) {
  for (const { obj, key } of job.refs) {
    obj[key] = rel || null;
    if (error) obj[key === 'file' ? 'error' : 'profile_pic_error'] = error;
  }
}

if (typeof module !== 'undefined') {
  module.exports = {
    parseBodies, threadIdFromPath, threadIdsOf, findMessageNodes, normalizeMessage, emptyState, ingest, summarize, buildExport, exportFilename,
    isMediaUrl, collectMediaUrls, mediaFileName, attachMedia, resolveJob,
  };
}
