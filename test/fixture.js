// Synthetic responses in the shape of Instagram's fetch__SlideThread query.
// All names/ids are made up; never put a real captured chat in here.

const users = {
  a: { fbid: '1001', igid: '2001', username: 'alice_test', name: 'Alice' },
  b: { fbid: '1002', igid: '2002', username: 'bob_test', name: 'Bob' },
};

function node(id, user, ts, text, extra = {}) {
  const u = users[user];
  return {
    id,
    message_id: id,
    sender_fbid: u.fbid,
    tombstone_reason: null,
    content: { __typename: 'SlideMessageText', __isSlideMessageContent: 'SlideMessageText', text_body: text },
    thread_fbid: '555',
    content_type: 'TEXT',
    timestamp_ms: String(ts),
    reactions: [],
    text_body: text,
    igd_is_forwarded: false,
    replied_to_message_id: null,
    replied_to_message: null,
    sender: {
      name: u.name,
      id: u.fbid,
      igid: u.igid,
      user_dict: { profile_pic_url: 'https://example.invalid/p.jpg', username: u.username, full_name: u.name, id: u.igid },
    },
    slide_edit_history: [],
    is_pinned: false,
    __typename: 'SlideMessage',
    ...extra,
  };
}

function page(nodes) {
  return {
    data: {
      fetch__SlideThread: {
        as_ig_direct_thread: {
          slide_messages: {
            edges: nodes.map((n) => ({ node: n, cursor: 'c' + n.id })),
            page_info: { has_next_page: true, has_previous_page: true },
          },
          id: '555',
        },
        id: '555',
      },
    },
    extensions: { is_final: true },
  };
}

// Newest page first, like scrolling up in the UI.
const page1 = page([
  node('m4', 'a', 1792545134899, 'four', {
    reactions: [{ reaction: '❤', sender_fbid: '1002' }],
  }),
  node('m3', 'b', 1792545117533, 'three', {
    replied_to_message_id: 'm1',
    replied_to_message: { message_id: 'm1', sender_fbid: '1001', text_body: 'one' },
  }),
]);
const page2 = page([
  node('m3', 'b', 1792545117533, 'three'), // overlap with page1
  node('m2', 'a', 1792545101347, null, {
    content_type: 'IMAGE',
    text_body: null,
    content: { __typename: 'SlideMessageImage', image_url: 'https://example.invalid/i.jpg' },
  }),
  node('m1', 'a', 1792545087708, 'one'),
]);

// SSR shape: same thread wrapped in a require/__bbox array inside a script tag.
const ssr = { require: [['ScheduledServerJS', 'handle', null, [{ __bbox: { result: page([node('m0', 'b', 1792545000000, 'zero')]) } }]]] };

// A graphql response that has nothing to do with DMs.
const unrelated = { data: { xdt_feed: { edges: [{ node: { id: 'p1' } }] } } };

module.exports = { users, page1, page2, ssr, unrelated };
