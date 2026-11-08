import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

process.env.ADMIN_PASSWORD = 'adminpass123';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test';
const { initDb, closeDb, setSetting, one } = await import('../server/db.js');
const { seed } = await import('../server/seed.js');
const { createApp } = await import('../server/app.js');
const { closedStatus, musicPeriod } = await import('../server/jewish.js');
const { parseVideoId } = await import('../server/youtube.js');

const SEED = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'seed');
let server;
let base;

before(async () => {
  await initDb({ memory: true });
  await seed();
  await setSetting('shabbos', { enabled: false, city: 'New York' }); // tests must not depend on the day of the week
  server = createApp().listen(0, '127.0.0.1');
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server.close();
  await closeDb();
});

function client() {
  const jar = new Map();
  return async function call(method, url, body, headers = {}) {
    const h = { ...headers };
    if (jar.size) h.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    let payload;
    if (body instanceof FormData) payload = body;
    else if (body !== undefined) {
      h['content-type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    const res = await fetch(base + url, { method, headers: h, body: payload, redirect: 'manual' });
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const [k, ...v] = pair.split('=');
      const val = v.join('=');
      if (!val || /Expires=Thu, 01 Jan 1970/.test(c)) jar.delete(k);
      else jar.set(k, val);
    }
    let data = null;
    try {
      data = await res.json();
    } catch {
      /* not json */
    }
    return { status: res.status, data, headers: res.headers };
  };
}

async function signup(name) {
  const c = client();
  const r = await c('POST', '/api/auth/signup', { username: name, password: 'password123' });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  return c;
}
async function admin() {
  const c = client();
  assert.equal((await c('POST', '/api/auth/login', { username: 'admin', password: 'adminpass123' })).status, 200);
  return c;
}

test('home lists the seeded YouTube catalogue by category', async () => {
  const r = await client()('GET', '/api/home');
  assert.equal(r.status, 200);
  assert.ok(r.data.sections.length >= 5);
  assert.ok(r.data.featured.length > 0);
  assert.ok(r.data.sections.flatMap((s) => s.videos).every((v) => v.ytId && v.thumbnail.startsWith('https://i.ytimg.com/')));
});

test('config reports Hebrew date and zmanim', async () => {
  const r = await client()('GET', '/api/config');
  assert.match(r.data.hebrewDate.he, /[א-ת]/);
  assert.equal(r.data.closed.closed, false);
});

test('signup and login validate input', async () => {
  const c = client();
  assert.equal((await c('POST', '/api/auth/signup', { username: 'x', password: 'password123' })).status, 400);
  assert.equal((await c('POST', '/api/auth/signup', { username: 'yossi', password: 'short' })).status, 400);
  assert.equal((await c('POST', '/api/auth/signup', { username: 'yossi', password: 'password123' })).status, 201);
  assert.equal((await client()('POST', '/api/auth/signup', { username: 'YOSSI', password: 'password123' })).status, 409);
  assert.equal((await client()('POST', '/api/auth/login', { username: 'yossi', password: 'wrongpass1' })).status, 401);
});

test('new creators’ statuses wait for review; trusted creators publish directly', async () => {
  const c = await signup('newcreator');
  const r = await c('POST', '/api/statuses', (() => {
    const f = new FormData();
    f.append('kind', 'text');
    f.append('body', 'Gut voch!');
    return f;
  })());
  assert.equal(r.status, 201);
  assert.equal(r.data.pending, true);
  const guest = client();
  const list = await guest('GET', '/api/statuses/by/newcreator?from=2000-01-01T00:00:00Z');
  assert.equal(list.data.statuses.length, 0, 'pending status is not public');

  const a = await admin();
  const pending = await a('GET', '/api/admin/statuses?status=pending');
  const mine = pending.data.statuses.find((s) => s.user.username === 'newcreator');
  assert.ok(mine);
  assert.equal((await a('PATCH', `/api/admin/statuses/${mine.id}`, { status: 'published', verifyCreator: true })).status, 200);
  const after2 = await guest('GET', '/api/statuses/by/newcreator?from=2000-01-01T00:00:00Z');
  assert.equal(after2.data.statuses.length, 1);

  const f2 = new FormData();
  f2.append('kind', 'text');
  f2.append('body', 'Now trusted');
  assert.equal((await c('POST', '/api/statuses', f2)).data.pending, false);
});

test('photo and video statuses must be real media', async () => {
  const c = await signup('mediauser');
  const bad = new FormData();
  bad.append('kind', 'video');
  bad.append('file', new Blob(['not a video']), 'x.mp4');
  assert.equal((await c('POST', '/api/statuses', bad)).status, 400);
  const good = new FormData();
  good.append('kind', 'image');
  good.append('file', new Blob([fs.readFileSync(path.join(SEED, 'status-gamzu.jpg'))]), 'a.jpg');
  const r = await c('POST', '/api/statuses', good);
  assert.equal(r.status, 201);
  const media = await fetch(base + r.data.status.mediaUrl, { headers: { range: 'bytes=0-99' } });
  assert.equal(media.status, 206);
  assert.equal((await media.arrayBuffer()).byteLength, 100);
});

test('parental controls filter content, need a PIN, and stay on the device after sign-out', async () => {
  const c = await signup('parent1');
  const before2 = await c('GET', '/api/videos?category=music');
  assert.ok(before2.data.videos.length > 0);
  assert.equal((await c('POST', '/api/parental', { newPin: '12', settings: { hideMusic: true } })).status, 400);
  assert.equal((await c('POST', '/api/parental', { newPin: '2468', settings: { hideMusic: true, kidsMode: false } })).status, 200);
  const filtered = await c('GET', '/api/videos?category=music');
  assert.equal(filtered.data.videos.length, 0);
  const musicVideo = before2.data.videos[0];
  assert.equal((await c('GET', `/api/videos/${musicVideo.id}`)).status, 403);

  // Changing settings needs the PIN
  assert.equal((await c('POST', '/api/parental', { pin: '0000', settings: {} })).status, 403);

  // Sign out: the device lock remains
  await c('POST', '/api/auth/logout');
  assert.equal((await c('GET', '/api/videos?category=music')).data.videos.length, 0);
  assert.equal((await c('POST', '/api/parental/disable', { pin: '1111' })).status, 403);
  assert.equal((await c('POST', '/api/parental/disable', { pin: '2468' })).status, 200);
  assert.ok((await c('GET', '/api/videos?category=music')).data.videos.length > 0);
});

test('kids mode only shows kid-safe videos', async () => {
  const c = await signup('kidsparent');
  await c('POST', '/api/parental', { newPin: '1357', settings: { kidsMode: true } });
  const home = await c('GET', '/api/home');
  const all = home.data.sections.flatMap((s) => s.videos);
  assert.ok(all.length > 0);
  assert.ok(all.every((v) => v.flags.kidSafe));
});

test('ads are admin-only, skipped for Premium, and count clicks', async () => {
  const guest = client();
  const ads = await guest('GET', '/api/ads?placement=banner');
  assert.equal(ads.data.ads.length, 1);
  const click = await guest('GET', ads.data.ads[0].href);
  assert.equal(click.status, 302);

  const u = await signup('premiumguy');
  const a = await admin();
  const users = await a('GET', '/api/admin/users?q=premiumguy');
  await a('PATCH', `/api/admin/users/${users.data.users[0].id}`, { premium: true });
  assert.equal((await u('GET', '/api/ads?placement=banner')).data.ads.length, 0);

  const plain = await signup('plainuser');
  assert.equal((await plain('POST', '/api/admin/ads', new FormData())).status, 403);
  const bad = new FormData();
  bad.append('title', 'Shop');
  bad.append('link', 'javascript:alert(1)');
  bad.append('file', new Blob([fs.readFileSync(path.join(SEED, 'ad-banner.jpg'))]), 'ad.jpg');
  assert.equal((await a('POST', '/api/admin/ads', bad)).status, 400);
});

test('downloads are Premium-only', async () => {
  const st = await one(`SELECT media_id FROM statuses WHERE media_id IS NOT NULL LIMIT 1`);
  const guest = await fetch(`${base}/media/${st.media_id}?download=1`);
  assert.equal(guest.status, 402);
  const u = await signup('downloader');
  const a = await admin();
  const users = await a('GET', '/api/admin/users?q=downloader');
  await a('PATCH', `/api/admin/users/${users.data.users[0].id}`, { premium: true });
  const cookieRes = await u('GET', '/api/me');
  assert.equal(cookieRes.data.user.premium, true);
});

test('admin import rejects non-YouTube links without calling YouTube', async () => {
  const a = await admin();
  const r = await a('POST', '/api/admin/videos/import', { urls: 'hello\nhttps://example.com/video' });
  assert.equal(r.status, 200);
  assert.ok(r.data.results.every((x) => !x.ok));
  assert.equal((await client()('GET', '/api/admin/stats')).status, 401);
});

test('YouTube link parsing', () => {
  assert.equal(parseVideoId('https://www.youtube.com/watch?v=FJQ4tCEwcMU&t=10'), 'FJQ4tCEwcMU');
  assert.equal(parseVideoId('https://youtu.be/FJQ4tCEwcMU'), 'FJQ4tCEwcMU');
  assert.equal(parseVideoId('https://www.youtube.com/shorts/FJQ4tCEwcMU'), 'FJQ4tCEwcMU');
  assert.equal(parseVideoId('https://vimeo.com/123'), null);
});

test('Shabbos closing follows candle lighting and havdalah', () => {
  // Saturday 14 Nov 2026, midday in New York: closed. Wednesday: open.
  assert.equal(closedStatus('New York', new Date('2026-11-14T17:00:00Z')).closed, true);
  assert.equal(closedStatus('New York', new Date('2026-11-11T17:00:00Z')).closed, false);
  // Yom Kippur 5788 starts the evening of 10 Oct 2027
  assert.equal(closedStatus('New York', new Date('2027-10-11T15:00:00Z')).closed, true);
});

test('music periods: Sefirah and the Three Weeks', () => {
  assert.equal(musicPeriod(new Date('2027-05-01T12:00:00Z')), 'sefirah');
  assert.equal(musicPeriod(new Date('2027-07-30T12:00:00Z')), 'three_weeks');
  assert.equal(musicPeriod(new Date('2027-01-10T12:00:00Z')), null);
});

test('Stripe webhook needs a valid signature and turns on Premium', async () => {
  const u = await signup('stripeuser');
  const me = (await u('GET', '/api/me')).data.user;
  const payload = JSON.stringify({ type: 'checkout.session.completed', data: { object: { client_reference_id: String(me.id), customer: 'cus_1', subscription: 'sub_1' } } });
  const bad = await fetch(base + '/api/stripe/webhook', { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': 't=1,v1=00' }, body: payload });
  assert.equal(bad.status, 400);
  const t = Math.floor(Date.now() / 1000);
  const sig = crypto.createHmac('sha256', 'whsec_test').update(`${t}.${payload}`).digest('hex');
  const ok = await fetch(base + '/api/stripe/webhook', { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': `t=${t},v1=${sig}` }, body: payload });
  assert.equal(ok.status, 200);
  assert.equal((await u('GET', '/api/me')).data.user.premium, true);
});

test('cross-site writes are blocked', async () => {
  const c = await signup('csrfcheck');
  const r = await c('PATCH', '/api/me', { displayName: 'x' }, { origin: 'https://evil.example' });
  assert.equal(r.status, 403);
});
