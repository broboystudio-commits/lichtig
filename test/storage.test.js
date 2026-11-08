// Creator uploads and link imports with S3-compatible storage (a tiny fake S3 server).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

const SEED = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'seed');
const SAMPLE = fs.readFileSync(path.join(SEED, 'short-avos.mp4'));

// ---- fake S3 ----
const objects = new Map();
const s3 = http.createServer(async (req, res) => {
  const key = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (req.method === 'PUT') {
    if (!req.headers['content-length']) {
      res.writeHead(411);
      return res.end('length required');
    }
    const chunks = [];
    for await (const c of req) chunks.push(c);
    objects.set(key, { body: Buffer.concat(chunks), type: req.headers['content-type'] });
    res.writeHead(200);
    return res.end();
  }
  const obj = objects.get(key);
  if (req.method === 'DELETE') {
    objects.delete(key);
    res.writeHead(204);
    return res.end();
  }
  if (!obj) {
    res.writeHead(404);
    return res.end();
  }
  if (req.method === 'HEAD') {
    res.writeHead(200, { 'Content-Length': obj.body.length, 'Content-Type': obj.type });
    return res.end();
  }
  const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
  if (m) {
    const start = Number(m[1]);
    const end = m[2] ? Math.min(Number(m[2]), obj.body.length - 1) : obj.body.length - 1;
    res.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${obj.body.length}`, 'Content-Length': end - start + 1, 'Content-Type': obj.type });
    return res.end(obj.body.subarray(start, end + 1));
  }
  res.writeHead(200, { 'Content-Length': obj.body.length, 'Content-Type': obj.type });
  res.end(obj.body);
});

// ---- a "Google Drive"-like file host for imports ----
const files = http.createServer((req, res) => {
  if (req.url === '/video.mp4') {
    res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': SAMPLE.length });
    return res.end(SAMPLE);
  }
  if (req.url === '/redirect') {
    res.writeHead(302, { Location: '/video.mp4' });
    return res.end();
  }
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end('<html>Sign in to continue</html>');
});

let app;
let base;
let filesBase;
let db;

before(async () => {
  s3.listen(0, '127.0.0.1');
  files.listen(0, '127.0.0.1');
  await Promise.all([once(s3, 'listening'), once(files, 'listening')]);
  process.env.S3_ENDPOINT = `http://127.0.0.1:${s3.address().port}`;
  process.env.S3_BUCKET = 'lichtig-test';
  process.env.S3_ACCESS_KEY_ID = 'test';
  process.env.S3_SECRET_ACCESS_KEY = 'test';
  process.env.ADMIN_PASSWORD = 'adminpass123';
  process.env.ALLOW_PRIVATE_IMPORTS = 'true';
  filesBase = `http://127.0.0.1:${files.address().port}`;
  db = await import('../server/db.js');
  await db.initDb({ memory: true });
  await (await import('../server/seed.js')).seed({ demoContent: false });
  await db.setSetting('shabbos', { enabled: false, city: 'New York' });
  app = (await import('../server/app.js')).createApp().listen(0, '127.0.0.1');
  await once(app, 'listening');
  base = `http://127.0.0.1:${app.address().port}`;
});

after(async () => {
  app.close();
  s3.close();
  files.close();
  await db.closeDb();
});

function client() {
  let cookie = '';
  return async (method, url, body, extra = {}) => {
    const headers = { ...(extra.headers || {}) };
    if (cookie) headers.cookie = cookie;
    let payload = body;
    if (body && !(body instanceof FormData) && !(body instanceof Uint8Array)) {
      headers['content-type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    const res = await fetch(base + url, { method, headers, body: payload });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    let data = null;
    try {
      data = await res.json();
    } catch {
      /* not json */
    }
    return { status: res.status, data };
  };
}

async function admin() {
  const c = client();
  assert.equal((await c('POST', '/api/auth/login', { username: 'admin', password: 'adminpass123' })).status, 200);
  return c;
}

test('config reports cloud storage and the big-video limit', async () => {
  const r = await client()('GET', '/api/config');
  assert.equal(r.data.storage, 'cloud');
  assert.ok(r.data.maxVideoMb >= 1000);
});

test('creator applies, admin approves, creator uploads through Lichtig into storage', async () => {
  const c = client();
  await c('POST', '/api/auth/signup', { username: 'singer1', password: 'password123', displayName: 'Singer One' });
  assert.equal((await c('POST', '/api/creator/uploads', { filename: 'a.mp4', size: 10, mime: 'video/mp4' })).status, 403, 'not a creator yet');
  assert.equal((await c('POST', '/api/creator/apply', { channel: 'Singer One Music', about: 'Niggunim' })).data.creatorStatus, 'pending');

  const a = await admin();
  const apps = await a('GET', '/api/admin/creators?status=pending');
  const mine = apps.data.creators.find((x) => x.username === 'singer1');
  assert.equal(mine.channel, 'Singer One Music');
  await a('PATCH', `/api/admin/creators/${mine.id}`, { status: 'approved' });

  const slot = await c('POST', '/api/creator/uploads', { filename: 'clip.mp4', size: SAMPLE.length, mime: 'video/mp4' });
  assert.equal(slot.status, 201);
  assert.match(slot.data.uploadUrl, /^\/api\/creator\/uploads\/\d+$/, 'uploads go to Lichtig, not straight to storage');
  const put = await c('PUT', slot.data.uploadUrl, new Uint8Array(SAMPLE), { headers: { 'content-type': 'video/mp4' } });
  assert.equal(put.status, 200);
  assert.equal(objects.size, 1, 'file landed in storage');

  const noRights = new FormData();
  noRights.append('mediaId', slot.data.mediaId);
  noRights.append('title', 'Niggun');
  assert.equal((await c('POST', '/api/creator/videos', noRights)).status, 400, 'rights confirmation required');

  const fd = new FormData();
  fd.append('mediaId', slot.data.mediaId);
  fd.append('title', 'Niggun for Shabbos');
  fd.append('rights', '1');
  fd.append('music', '1');
  const created = await c('POST', '/api/creator/videos', fd);
  assert.equal(created.status, 201);
  assert.equal(created.data.pending, true, 'creator videos wait for review');

  const pending = await a('GET', '/api/admin/videos?status=pending');
  const v = pending.data.videos.find((x) => x.id === created.data.id);
  assert.match(v.rightsNote, /Confirmed by @singer1/);
  assert.equal(v.creator, 'singer1');
  await a('PATCH', `/api/admin/videos/${v.id}`, { status: 'published' });

  const watch = await client()('GET', `/api/videos/${v.id}`);
  assert.equal(watch.status, 200);
  assert.equal(watch.data.video.creator.username, 'singer1');
  const media = await fetch(base + watch.data.video.mediaUrl, { headers: { range: 'bytes=0-99' } });
  assert.equal(media.status, 206, 'streams from storage with seeking');
  assert.equal((await media.arrayBuffer()).byteLength, 100);

  const channel = await client()('GET', '/api/creators/singer1');
  assert.equal(channel.data.videos.length, 1);
  const home = await client()('GET', '/api/home');
  assert.ok(home.data.originals.some((x) => x.id === v.id), 'shows in Lichtig Originals');

  assert.equal((await c('DELETE', `/api/creator/videos/${v.id}`)).status, 200);
  assert.equal(objects.size, 0, 'file removed from storage');
});

test('upload size must match what was reserved', async () => {
  const a = await admin();
  const slot = await a('POST', '/api/creator/uploads', { filename: 'x.mp4', size: SAMPLE.length + 5, mime: 'video/mp4' });
  const put = await a('PUT', slot.data.uploadUrl, new Uint8Array(SAMPLE), { headers: { 'content-type': 'video/mp4' } });
  assert.equal(put.status, 400);
});

test('admin imports a shared link in the background; video-site links are refused', async () => {
  const a = await admin();
  const yt = await a('POST', '/api/admin/videos/import-link', { link: 'https://www.youtube.com/watch?v=FJQ4tCEwcMU', title: 'x', rightsNote: 'y' });
  assert.equal(yt.status, 400);
  assert.match(yt.data.message, /doesn't copy videos from YouTube/);
  assert.equal((await a('POST', '/api/admin/videos/import-link', { link: filesBase + '/video.mp4', title: 'x' })).status, 400, 'permission note required');

  const ok = await a('POST', '/api/admin/videos/import-link', { link: filesBase + '/redirect', title: 'Shiur from a creator', rightsNote: 'Sent by the maggid shiur', publish: true });
  assert.equal(ok.status, 202);
  const bad = await a('POST', '/api/admin/videos/import-link', { link: filesBase + '/not-a-video', title: 'Broken', rightsNote: 'x' });
  assert.equal(bad.status, 202);

  let list;
  for (let i = 0; i < 50; i++) {
    list = await a('GET', '/api/admin/videos?status=importing');
    if (!list.data.videos.some((v) => v.status === 'processing')) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  const failed = list.data.videos.find((v) => v.id === bad.data.id);
  assert.equal(failed.status, 'failed');
  assert.match(failed.importError, /web page, not a video/);

  const pub = await client()('GET', `/api/videos/${ok.data.id}`);
  assert.equal(pub.status, 200, 'imported video is live');
  assert.match(pub.data.video.mediaUrl, /^\/media\/\d+$/);
});
