// Following YouTube channels without an API key, through each channel's public uploads feed.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';

const CHANNEL = 'UCabcdefghijklmnopqrstuv';
let feedIds = ['AAAAAAAAAA1', 'AAAAAAAAAA2'];
let feedStatus = 200;

const entry = (id, n) => `
  <entry>
    <id>yt:video:${id}</id>
    <yt:videoId>${id}</yt:videoId>
    <yt:channelId>${CHANNEL}</yt:channelId>
    <title>Shiur ${n} &amp; more</title>
    <published>2026-11-0${n}T10:00:00+00:00</published>
    <media:group>
      <media:title>Shiur ${n} &amp; more</media:title>
      <media:description>Parsha &quot;Lech Lecha&quot;</media:description>
    </media:group>
  </entry>`;

// ---- a stand-in for youtube.com: the uploads feed and oEmbed ----
const fake = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/feeds/videos.xml') {
    if (url.searchParams.get('channel_id') !== CHANNEL) {
      res.writeHead(404);
      return res.end();
    }
    if (feedStatus !== 200) {
      res.writeHead(feedStatus);
      return res.end();
    }
    res.writeHead(200, { 'Content-Type': 'application/atom+xml' });
    return res.end(`<?xml version="1.0"?><feed xmlns:yt="http://www.youtube.com/xml/schemas/2015">
  <title>Daf Yomi Channel</title>
  <author><name>Daf Yomi Channel</name></author>${feedIds.map((id, i) => entry(id, i + 1)).join('')}
</feed>`);
  }
  if (url.pathname === '/oembed') {
    const id = new URL(url.searchParams.get('url')).searchParams.get('v');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ title: 'oEmbed title ' + id, author_name: 'Daf Yomi Channel', author_url: 'https://www.youtube.com/@dafyomi' }));
  }
  res.writeHead(404);
  res.end();
});

let app;
let base;
let db;
let admin;

before(async () => {
  fake.listen(0, '127.0.0.1');
  await once(fake, 'listening');
  process.env.YOUTUBE_BASE = `http://127.0.0.1:${fake.address().port}`;
  delete process.env.YOUTUBE_API_KEY;
  process.env.ADMIN_PASSWORD = 'adminpass123';
  db = await import('../server/db.js');
  admin = await import('../server/admin.js');
  await db.initDb({ memory: true });
  await (await import('../server/seed.js')).seed({ demoContent: false });
  await db.setSetting('shabbos', { enabled: false, city: 'New York' });
  app = (await import('../server/app.js')).createApp().listen(0, '127.0.0.1');
  await once(app, 'listening');
  base = `http://127.0.0.1:${app.address().port}`;
});

after(async () => {
  app.close();
  fake.close();
  await db.closeDb();
});

async function adminClient() {
  let cookie = '';
  const call = async (method, url, body) => {
    const headers = { 'content-type': 'application/json' };
    if (cookie) headers.cookie = cookie;
    const res = await fetch(base + url, { method, headers, body: body ? JSON.stringify(body) : undefined });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return { status: res.status, data: await res.json().catch(() => null) };
  };
  assert.equal((await call('POST', '/api/auth/login', { username: 'admin', password: 'adminpass123' })).status, 200);
  return call;
}

test('without an API key, an @name link asks for the channel ID link', async () => {
  const a = await adminClient();
  const r = await a('POST', '/api/admin/channels', { url: 'https://www.youtube.com/@dafyomi' });
  assert.equal(r.status, 400);
  assert.match(r.data.message, /Copy channel ID/);
});

test('a channel ID link is followed through the public feed, no API key needed', async () => {
  const a = await adminClient();
  const r = await a('POST', '/api/admin/channels', { url: `https://www.youtube.com/channel/${CHANNEL}/videos`, category: 'torah' });
  assert.equal(r.status, 201);
  assert.deepEqual(r.data.sync, { added: 2, checked: 2 });

  const { data } = await a('GET', '/api/admin/channels');
  const ch = data.channels.find((c) => c.id === r.data.id);
  assert.equal(ch.name, 'Daf Yomi Channel');
  assert.equal(ch.autoSync, true);
  assert.equal(ch.videoCount, 2);
  assert.equal(ch.syncError, null);

  const pending = await a('GET', '/api/admin/videos?status=pending');
  const v = pending.data.videos.find((x) => x.ytId === 'AAAAAAAAAA1');
  assert.ok(v, 'new uploads from an untrusted channel wait in review');
  assert.equal(v.title, 'Shiur 1 & more', 'title comes from the feed, with entities decoded');

  // a bare channel ID works too, and re-adding the same channel doesn't duplicate it
  const again = await a('POST', '/api/admin/channels', { url: CHANNEL, trusted: true });
  assert.equal(again.data.id, r.data.id);
  assert.deepEqual(again.data.sync, { added: 0, checked: 2 });
});

test('the scheduled check only fetches followed channels that are due, and records failures', async () => {
  const a = await adminClient();
  const { data } = await a('GET', '/api/admin/channels');
  const ch = data.channels.find((c) => c.url.endsWith(CHANNEL));

  feedIds = ['AAAAAAAAAA3', ...feedIds];
  assert.equal(await admin.syncDueChannels(), 0, 'checked moments ago, so not due yet');

  await db.query("UPDATE channels SET last_synced_at = now() - interval '7 hours' WHERE id = $1", [ch.id]);
  assert.equal(await admin.syncDueChannels(), 1);
  const published = await a('GET', '/api/admin/videos?status=published');
  assert.ok(published.data.videos.some((v) => v.ytId === 'AAAAAAAAAA3'), 'the channel is trusted now, so its new upload goes live');

  feedStatus = 500;
  await db.query("UPDATE channels SET last_synced_at = now() - interval '7 hours' WHERE id = $1", [ch.id]);
  await admin.syncDueChannels();
  const after = (await a('GET', '/api/admin/channels')).data.channels.find((c) => c.id === ch.id);
  assert.match(after.syncError, /didn't answer/);
  assert.equal(await admin.syncDueChannels(), 0, 'a failed check waits 6 hours before trying again');
  feedStatus = 200;

  await a('PATCH', `/api/admin/channels/${ch.id}`, { autoSync: false });
  await db.query("UPDATE channels SET last_synced_at = now() - interval '7 hours' WHERE id = $1", [ch.id]);
  assert.equal(await admin.syncDueChannels(), 0, 'channels with auto-update off are skipped');
});
