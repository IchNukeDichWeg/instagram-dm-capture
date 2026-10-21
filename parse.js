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
      for (const e of sm.edges) if (e && e.node) found.push({ node: e.node, threadId: v.id || null });
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
  return { messages: {}, participants: {}, responses: 0 };
}

// Merge one response body into state in place. Returns how many messages
// were new. Re-seen messages are overwritten so reaction/edit updates win.
function ingest(state, text) {
  let added = 0;
  let hit = false;
  for (const doc of parseBodies(text)) {
    for (const { node, threadId } of findMessageNodes(doc)) {
      const msg = normalizeMessage(node, threadId);
      if (!msg.id) continue;
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
  return { count: msgs.length, threads: threads.size, responses: state.responses, oldest, newest };
}

function buildExport(state, exportedAt = new Date()) {
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
  const date = data.exported_at.slice(0, 10);
  if (data.threads.length !== 1) return `instagram-dm-${data.threads.length}threads-${date}.json`;
  const names = data.threads[0].participants
    .map((p) => p.username || p.id)
    .filter(Boolean)
    .join('_')
    .replace(/[^A-Za-z0-9._-]/g, '')
    .slice(0, 80);
  return `instagram-dm-${names || data.threads[0].thread_id}-${date}.json`;
}

if (typeof module !== 'undefined') {
  module.exports = { parseBodies, findMessageNodes, normalizeMessage, emptyState, ingest, summarize, buildExport, exportFilename };
}
