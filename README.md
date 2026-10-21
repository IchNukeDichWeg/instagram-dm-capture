# Instagram DM Capture

Chrome extension (Manifest V3) that reads the Instagram web app's own
GraphQL responses while you scroll a chat and exports the messages as JSON.
It never sends requests to Instagram itself; everything stays in the
browser until you save. The only fetches it makes are the optional media
downloads from Instagram's CDN when you save.

## Install

1. Open `chrome://extensions`, enable **Developer mode**.
2. **Load unpacked** and pick this folder.
3. Pin the extension so its button is in the toolbar.

## Use

1. Open the chat on `https://www.instagram.com/direct/...`.
2. Click the extension, then **Start capture**. Start always begins a fresh capture.
3. Refresh the page.
4. Scroll up in the chat. Each page Instagram loads is captured; the popup
   shows the message count and the oldest message reached so far.
5. Click **Finish & save JSON**. The file goes to `~/Downloads` as
   `instagram-dm-<usernames>-<date>.json`. **Save JSON again** re-downloads
   the same capture; **Clear** discards it.

### Saving media locally

Tick **Save photos, videos & profile pictures locally** before saving
(the setting is remembered). The save then becomes a folder:

```
~/Downloads/instagram-dm-<usernames>-<date>/
  chat.json
  media/
    331068570_..._n.jpg
    ...
```

Every message with media gets a `media` list, and every participant a
`profile_pic_file`, holding paths relative to `chat.json`. The original URL
stays next to each path. A file that fails to download keeps `file: null`
plus an `error`; the popup shows how many failed. Downloads run in the
background, so the popup can be closed while it saves. Saving again on the
same day replaces that folder in place.

The capture survives closing the popup, switching chats (each chat becomes
its own thread in the file) and Chrome suspending the extension's worker.

## Output

```json
{
  "exported_at": "2026-10-21T10:00:00.000Z",
  "source": "instagram.com graphql slide_messages",
  "message_count": 4,
  "thread_count": 1,
  "threads": [
    {
      "thread_id": "555",
      "participants": [
        { "id": "1001", "igid": "2001", "username": "alice_test", "name": "Alice", "profile_pic_url": "..." }
      ],
      "message_count": 4,
      "first_message_at": "...",
      "last_message_at": "...",
      "messages": [
        {
          "id": "mid.$...",
          "thread_id": "555",
          "timestamp_ms": 1792545134899,
          "time": "2026-10-21T...Z",
          "sender_id": "1001",
          "sender_username": "alice_test",
          "sender_name": "Alice",
          "type": "TEXT",
          "text": "hello",
          "reactions": [{ "emoji": "❤", "sender_id": "1002" }],
          "replied_to_message_id": null,
          "replied_to": null,
          "is_forwarded": false,
          "is_pinned": false,
          "is_unsent": false,
          "edit_history": []
        }
      ]
    }
  ]
}
```

Messages are sorted oldest first and deduplicated by id. `time` is UTC.
Non-text messages (photos, reels, voice, links) also carry the raw `content`
object, since its shape differs per type. `profile_pic_url` and media URLs
are signed CDN links that expire after a while, which is what the media
option is for.

With media saved, a photo message also has:

```json
"media": [
  { "path": "content.image_versions2.candidates[0].url", "url": "https://scontent...", "file": "media/331068570_..._n.jpg" }
]
```

`path` is where in `content` the URL was found. Only URLs on Instagram's
CDN hosts (`*.cdninstagram.com`, `*.fbcdn.net`) count as media, and when
`content` lists several sizes of one image only the largest is saved. The
top level gains `media_file_count` and `media_failed_count`.

## How it works

- `hook.js` runs in the page's JS world at `document_start` and wraps
  `fetch` and `XMLHttpRequest`. Responses from `/api/graphql` or
  `/graphql/query` containing `slide_messages` are posted to the bridge.
- `bridge.js` (isolated content script) relays them to the worker, and on
  load also scans inline `<script type="application/json">` blobs, because
  the first page of a thread can be server-rendered instead of fetched.
- `background.js` merges each response into `chrome.storage.local` through
  a single queue, only while a capture is running. On save it downloads
  media 4 at a time, then writes the JSON through a blob URL made in
  `offscreen.html` (a service worker can't make blob URLs, and `data:` URLs
  cap at 2 MB).
- `parse.js` holds all parsing and export logic. It walks any JSON shape for
  `slide_messages.edges`, so it is not tied to one query name.

## Known limits

- Only messages Instagram loads over GraphQL or embeds in the page are seen.
  Messages that arrive live while the chat is open come over a websocket and
  are not captured; refresh and scroll again to pick them up.
- If Instagram renames `slide_messages` or moves DMs to another transport,
  the capture will show 0 and `parse.js` needs updating.
- Tested against synthetic responses with the same shape as a real
  `fetch__SlideThread` response, not against live instagram.com. The
  shape of photo/video/voice `content` objects is not known from a real
  capture, so media detection is generic (any CDN URL in `content`).
- Media URLs are fetched without Instagram cookies. Signed CDN URLs normally
  don't need them; if some do, those files show up as failed.

## Tests

```bash
node test/test.js
```

```bash
node test/hook-test.js
```

```bash
node test/e2e-test.js
```

`test.js` covers parsing, dedupe, export, media planning and the background
worker (with a mocked `chrome`). `hook-test.js` runs `hook.js` in headless
Google Chrome against a local fake GraphQL endpoint and checks fetch plus
every XHR response type. `e2e-test.js` loads the real extension in Chrome
for Testing (branded Chrome ignores `--load-extension`), maps
`www.instagram.com` and a fake CDN host to a local HTTPS server, and checks
capture, the media folder, a 404 file, re-save and plain save on disk. It
takes ~3 s and uses the newest Chrome for Testing in Puppeteer's cache:

```bash
npx @puppeteer/browsers install chrome@stable --path ~/.cache/puppeteer
```

Fixtures are synthetic; never commit a real captured chat.
