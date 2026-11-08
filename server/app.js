import path from 'path';
import { fileURLToPath } from 'url';
import express from 'express';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import multer from 'multer';
import { rateLimit } from 'express-rate-limit';

import { query, one, many, getSettings, ms } from './db.js';
import * as auth from './auth.js';
import { storeMedia, serveMedia, mediaUrl, deleteMedia, IMAGE_TYPES, VIDEO_TYPES } from './media.js';
import {
  effectiveFilters,
  videoConditions,
  statusConditions,
  publicParental,
  sanitizeFilters,
  readLock,
  writeLock,
  clearLock,
} from './parental.js';
import { closedStatus, hebrewDate, musicPeriod } from './jewish.js';
import { hasApiKey } from './youtube.js';
import * as stripe from './stripe.js';
import { adminRouter } from './admin.js';
import { creatorRouter } from './creator.js';
import { storageEnabled } from './storage.js';
import { maxVideoBytes } from './media.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const IS_PROD = process.env.NODE_ENV === 'production';
export const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB) || 25;
const STATUS_BGS = ['#123b7a', '#0f766e', '#7c2d12', '#6b21a8', '#1f2937', '#b45309', '#be123c', '#065f46'];

// ---------- small helpers ----------

/** Builds $1, $2… placeholders as values are added. */
export class Params {
  constructor() {
    this.values = [];
  }
  add(v) {
    this.values.push(v);
    return '$' + this.values.length;
  }
}

export const idParam = (req, name = 'id') => {
  const n = Number(req.params[name]);
  return Number.isInteger(n) && n > 0 ? n : null;
};

const bool = (v) => v === true || v === 'true' || v === '1' || v === 'on' || v === 1;

let settingsCache = null;
let settingsAt = 0;
export async function settingsCached() {
  if (!settingsCache || Date.now() - settingsAt > 30000) {
    settingsCache = await getSettings();
    settingsAt = Date.now();
  }
  return settingsCache;
}
export const invalidateSettings = () => {
  settingsCache = null;
};

export const userDto = (u) =>
  u && {
    username: u.username,
    displayName: u.display_name,
    avatarUrl: mediaUrl(u.avatar_media_id),
    verified: !!u.verified,
  };

export function meDto(u) {
  return {
    id: u.id,
    username: u.username,
    displayName: u.display_name,
    avatarUrl: mediaUrl(u.avatar_media_id),
    role: u.role,
    verified: !!u.verified,
    premium: !!u.is_premium || u.role === 'admin',
    premiumSource: u.premium_source,
    hasBilling: !!u.stripe_customer_id,
    lang: u.lang,
    bio: u.bio,
    parental: publicParental(u.parental),
    showWomenImages: !!u.show_women_images,
    showWomenSinging: !!u.show_women_singing,
    creatorStatus: u.role === 'admin' ? 'approved' : u.creator_status,
  };
}

export const VIDEO_COLUMNS = `
  v.*, c.slug AS cat_slug, c.name_en AS cat_en, c.name_yi AS cat_yi,
  (SELECT COUNT(*)::int FROM likes l WHERE l.video_id = v.id) AS like_count,
  (SELECT username FROM users cu WHERE cu.id = v.creator_id) AS creator_username`;

export function videoDto(r) {
  return {
    id: r.id,
    source: r.source,
    ytId: r.yt_id,
    mediaUrl: mediaUrl(r.media_id),
    title: r.title,
    description: r.description,
    channelName: r.channel_name,
    thumbnail: r.thumbnail_url || mediaUrl(r.poster_media_id) || null,
    durationS: r.duration_s,
    creator: r.creator_username ? { username: r.creator_username } : null,
    category: r.cat_slug ? { slug: r.cat_slug, nameEn: r.cat_en, nameYi: r.cat_yi } : null,
    flags: {
      kidSafe: r.kid_safe,
      music: r.has_music,
      womenSinging: r.women_singing,
      womenImages: r.women_images,
      news: r.is_news,
    },
    status: r.status,
    featured: r.featured,
    views: r.views,
    likes: r.like_count ?? 0,
    saved: r.is_saved ?? false,
    liked: r.is_liked ?? false,
    publishedAt: ms(r.published_at || r.created_at),
  };
}

export function statusDto(r) {
  return {
    id: r.id,
    kind: r.kind,
    body: r.body,
    bg: r.bg,
    mediaUrl: mediaUrl(r.media_id),
    status: r.status,
    views: r.views,
    createdAt: ms(r.created_at),
    flags: { music: r.has_music, womenSinging: r.women_singing, womenImages: r.women_images, kidSafe: r.kid_safe },
    user: r.username
      ? { username: r.username, displayName: r.display_name, avatarUrl: mediaUrl(r.avatar_media_id), verified: !!r.verified }
      : undefined,
  };
}

function parseRange(req) {
  const now = Date.now();
  let from = Date.parse(req.query.from);
  let to = Date.parse(req.query.to);
  if (!Number.isFinite(from)) from = now - 24 * 3600 * 1000;
  if (!Number.isFinite(to)) to = now + 60 * 1000;
  if (to - from > 8 * 24 * 3600 * 1000) from = to - 8 * 24 * 3600 * 1000;
  return { from: new Date(from), to: new Date(to) };
}

const isPremium = (u) => !!u && (u.is_premium || u.role === 'admin');

async function pickAds(req, placement, n = 1) {
  if (isPremium(req.user)) return [];
  const rows = await many(
    `SELECT a.id, a.title, a.media_id, a.weight, m.mime FROM ads a JOIN media m ON m.id = a.media_id
     WHERE a.active AND a.placement = $1
       AND (a.starts_at IS NULL OR a.starts_at <= now()) AND (a.ends_at IS NULL OR a.ends_at >= now())`,
    [placement],
  );
  const picked = [];
  const pool = [...rows];
  while (picked.length < n && pool.length) {
    const total = pool.reduce((s, a) => s + Math.max(1, a.weight), 0);
    let r = Math.random() * total;
    const idx = pool.findIndex((a) => (r -= Math.max(1, a.weight)) <= 0);
    picked.push(pool.splice(idx < 0 ? 0 : idx, 1)[0]);
  }
  return picked.map((a) => ({
    id: a.id,
    title: a.title,
    mediaUrl: mediaUrl(a.media_id),
    mime: a.mime,
    href: `/api/ads/${a.id}/click`,
  }));
}

// ---------- app ----------

export function createApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'", 'https://www.youtube.com', 'https://s.ytimg.com'],
          styleSrc: ["'self'", 'https://fonts.googleapis.com'],
          fontSrc: ["'self'", 'https://fonts.gstatic.com'],
          imgSrc: ["'self'", 'data:', 'blob:', 'https://i.ytimg.com', 'https://yt3.ggpht.com'],
          mediaSrc: ["'self'", 'blob:'],
          frameSrc: ['https://www.youtube-nocookie.com', 'https://www.youtube.com'],
          connectSrc: ["'self'"],
          objectSrc: ["'none'"],
          frameAncestors: ["'none'"],
          upgradeInsecureRequests: IS_PROD ? [] : null,
        },
      },
      crossOriginEmbedderPolicy: false,
      referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    }),
  );
  app.use(cookieParser());

  // Stripe needs the raw body for signature checks, so this comes before express.json().
  app.post('/api/stripe/webhook', express.raw({ type: 'application/json', limit: '1mb' }), async (req, res) => {
    let event;
    try {
      event = stripe.verifyWebhook(req.body.toString('utf8'), req.get('stripe-signature'));
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
    const obj = event.data && event.data.object;
    if (event.type === 'checkout.session.completed' && obj.client_reference_id) {
      await query(
        `UPDATE users SET is_premium = TRUE, premium_source = 'stripe', stripe_customer_id = $2,
         stripe_subscription_id = $3 WHERE id = $1`,
        [Number(obj.client_reference_id), obj.customer, obj.subscription],
      );
    } else if (event.type === 'customer.subscription.updated' || event.type === 'customer.subscription.deleted') {
      const active = event.type === 'customer.subscription.updated' && ['active', 'trialing'].includes(obj.status);
      await query(
        `UPDATE users SET is_premium = $2, premium_source = CASE WHEN $2 THEN 'stripe' ELSE NULL END
         WHERE stripe_subscription_id = $1 AND premium_source IS DISTINCT FROM 'admin'`,
        [obj.id, active],
      );
    }
    res.json({ received: true });
  });

  app.use(express.json({ limit: '50kb' }));
  app.use((req, _res, next) => {
    if (req.body === undefined) req.body = {};
    next();
  });
  app.use(auth.loadUser);

  // Block cross-site writes.
  app.use((req, res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    const origin = req.get('origin');
    if (!origin) return next();
    try {
      if (new URL(origin).host === req.get('host')) return next();
    } catch {
      /* fall through */
    }
    res.status(403).json({ error: 'forbidden', message: 'Request blocked.' });
  });

  // Shabbos / Yom Tov: the whole site rests from candle lighting to havdalah.
  app.use(async (req, res, next) => {
    try {
      const p = req.path;
      if (p === '/healthz' || p === '/api/config' || (!p.startsWith('/api/') && !p.startsWith('/media/'))) return next();
      const s = await settingsCached();
      if (!s.shabbos?.enabled) return next();
      const st = closedStatus(s.shabbos.city);
      if (!st.closed) return next();
      res.status(503).json({ error: 'closed', message: 'Closed for Shabbos / Yom Tov.', reopensAt: st.reopensAt, tzid: st.tzid });
    } catch (err) {
      next(err);
    }
  });

  const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 40, standardHeaders: true, legacyHeaders: false });
  const writeLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    limit: 60,
    keyGenerator: (req) => 'u' + (req.user ? req.user.id : 0),
    message: { error: 'rate_limited', message: 'Too many uploads. Try again later.' },
  });
  app.use('/api', rateLimit({ windowMs: 60 * 1000, limit: 900, standardHeaders: true, legacyHeaders: false }));

  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024, files: 1, fields: 30 } });
  const single = (field) => (req, res, next) =>
    upload.single(field)(req, res, (err) => {
      if (!err) return next();
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({ error: 'too_large', message: `Files can be up to ${MAX_UPLOAD_MB} MB.` });
      }
      res.status(400).json({ error: 'bad_upload', message: 'Upload failed.' });
    });

  const filtersFor = async (req) => effectiveFilters(req, await settingsCached());

  // ---------- meta ----------

  app.get('/healthz', (_req, res) => res.json({ ok: true }));

  app.get('/api/config', async (req, res, next) => {
    try {
      const s = await settingsCached();
      const closed = s.shabbos?.enabled ? closedStatus(s.shabbos.city) : { closed: false };
      const f = await filtersFor(req);
      const [banner] = await pickAds(req, 'banner', 1);
      res.json({
        siteName: s.siteName,
        announcement: s.announcement,
        closed,
        shabbosEnabled: !!s.shabbos?.enabled,
        hebrewDate: hebrewDate(),
        musicPeriod: musicPeriod(),
        filters: f,
        premiumPrice: s.premiumPrice,
        payments: stripe.paymentsEnabled(),
        youtubeApi: hasApiKey(),
        demo: process.env.STORAGE_MODE === 'demo',
        maxUploadMb: MAX_UPLOAD_MB,
        storage: storageEnabled() ? 'cloud' : 'database',
        maxVideoMb: Math.round(maxVideoBytes() / 1048576),
        bannerAd: banner || null,
        user: req.user ? meDto(req.user) : null,
      });
    } catch (err) {
      next(err);
    }
  });

  app.get('/api/categories', async (_req, res) => {
    res.json({ categories: await many('SELECT slug, name_en, name_yi FROM categories ORDER BY sort, id') });
  });

  // ---------- auth ----------

  app.post('/api/auth/signup', authLimiter, async (req, res) => {
    const username = String(req.body.username || '').trim();
    const displayName = String(req.body.displayName || '').trim().slice(0, 40) || username;
    const password = String(req.body.password || '');
    const lang = req.body.lang === 'yi' ? 'yi' : 'en';
    if (!/^[A-Za-z0-9._]{3,24}$/.test(username)) {
      return res.status(400).json({ error: 'bad_username', message: 'Usernames are 3 to 24 letters, numbers, dots or underscores.' });
    }
    if (password.length < 8 || password.length > 200) {
      return res.status(400).json({ error: 'bad_password', message: 'Passwords need at least 8 characters.' });
    }
    if (await one('SELECT 1 FROM users WHERE lower(username) = lower($1)', [username])) {
      return res.status(409).json({ error: 'taken', message: 'That username is taken.' });
    }
    const u = await one(
      `INSERT INTO users (username, display_name, password_hash, lang) VALUES ($1, $2, $3, $4) RETURNING *`,
      [username, displayName, auth.hashPassword(password), lang],
    );
    await auth.createSession(res, u.id, req.secure);
    res.status(201).json({ user: meDto(u) });
  });

  const DUMMY = auth.hashPassword('timing-equaliser');
  app.post('/api/auth/login', authLimiter, async (req, res) => {
    const username = String(req.body.username || '').trim();
    const password = String(req.body.password || '');
    const u = await one('SELECT * FROM users WHERE lower(username) = lower($1)', [username]);
    const ok = auth.checkPassword(password, u ? u.password_hash : DUMMY);
    if (!u || !ok || u.banned) return res.status(401).json({ error: 'bad_login', message: 'Wrong username or password.' });
    await auth.createSession(res, u.id, req.secure);
    res.json({ user: meDto(u) });
  });

  app.post('/api/auth/logout', async (req, res) => {
    await auth.destroySession(req, res);
    res.json({ ok: true });
  });

  // ---------- me ----------

  app.get('/api/me', (req, res) => res.json({ user: req.user ? meDto(req.user) : null }));

  app.patch('/api/me', auth.requireAuth, async (req, res) => {
    const displayName =
      req.body.displayName === undefined ? req.user.display_name : String(req.body.displayName).trim().slice(0, 40);
    const bio = req.body.bio === undefined ? req.user.bio : String(req.body.bio).trim().slice(0, 200);
    const lang = req.body.lang === undefined ? req.user.lang : req.body.lang === 'yi' ? 'yi' : 'en';
    if (!displayName) return res.status(400).json({ error: 'bad_name', message: 'Display name cannot be empty.' });
    const showImages = req.body.showWomenImages === undefined ? req.user.show_women_images : bool(req.body.showWomenImages);
    const showSinging = req.body.showWomenSinging === undefined ? req.user.show_women_singing : bool(req.body.showWomenSinging);
    const u = await one(
      `UPDATE users SET display_name = $2, bio = $3, lang = $4, show_women_images = $5, show_women_singing = $6
       WHERE id = $1 RETURNING *`,
      [req.user.id, displayName, bio, lang, showImages, showSinging],
    );
    res.json({ user: meDto(u) });
  });

  app.post('/api/me/avatar', auth.requireAuth, writeLimiter, single('file'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'no_file', message: 'Choose a photo.' });
    const m = await storeMedia(req.file.buffer, req.user.id);
    if (!m || !IMAGE_TYPES.includes(m.mime)) {
      if (m) await deleteMedia(m.id);
      return res.status(400).json({ error: 'bad_type', message: 'Please choose a JPG, PNG, WebP or GIF photo.' });
    }
    const old = req.user.avatar_media_id;
    const u = await one('UPDATE users SET avatar_media_id = $2 WHERE id = $1 RETURNING *', [req.user.id, m.id]);
    if (old) await deleteMedia(old);
    res.json({ user: meDto(u) });
  });

  app.get('/api/me/saved', auth.requireAuth, async (req, res) => {
    const f = await filtersFor(req);
    const rows = await many(
      `SELECT ${VIDEO_COLUMNS}, TRUE AS is_saved FROM saved sv JOIN videos v ON v.id = sv.video_id
       LEFT JOIN categories c ON c.id = v.category_id
       WHERE sv.user_id = $1 AND ${videoConditions(f).join(' AND ')} ORDER BY sv.created_at DESC LIMIT 200`,
      [req.user.id],
    );
    const creators = await many(
      `SELECT u.* FROM follows f JOIN users u ON u.id = f.creator_id WHERE f.user_id = $1 ORDER BY f.created_at DESC`,
      [req.user.id],
    );
    res.json({ videos: rows.map(videoDto), creators: creators.map(userDto) });
  });

  // ---------- parental controls ----------

  app.get('/api/parental', async (req, res) => {
    res.json({
      account: req.user ? publicParental(req.user.parental) : null,
      deviceLocked: !!readLock(req),
      effective: await filtersFor(req),
    });
  });

  const pinOk = (pin) => /^\d{4,8}$/.test(String(pin || ''));

  app.post('/api/parental', auth.requireAuth, authLimiter, async (req, res) => {
    const current = req.user.parental || {};
    const { pin, newPin } = req.body;
    let pinHash = current.pinHash;
    if (current.enabled) {
      if (!pinOk(pin) || !auth.checkPassword(String(pin), current.pinHash)) {
        return res.status(403).json({ error: 'bad_pin', message: 'Wrong PIN.' });
      }
      if (newPin !== undefined && newPin !== '') {
        if (!pinOk(newPin)) return res.status(400).json({ error: 'bad_pin', message: 'PINs are 4 to 8 digits.' });
        pinHash = auth.hashPassword(String(newPin));
      }
    } else {
      if (!pinOk(newPin || pin)) return res.status(400).json({ error: 'bad_pin', message: 'Choose a PIN of 4 to 8 digits.' });
      pinHash = auth.hashPassword(String(newPin || pin));
    }
    const parental = { enabled: true, pinHash, ...sanitizeFilters(req.body.settings) };
    const u = await one('UPDATE users SET parental = $2::jsonb WHERE id = $1 RETURNING *', [
      req.user.id,
      JSON.stringify(parental),
    ]);
    req.user = u;
    writeLock(res, parental, req.secure);
    res.json({ parental: publicParental(parental), effective: await filtersFor(req) });
  });

  app.post('/api/parental/disable', authLimiter, async (req, res) => {
    const pin = String(req.body.pin || '');
    const device = readLock(req);
    const account = req.user?.parental?.enabled ? req.user.parental : null;
    const hashes = [account?.pinHash, device?.pinHash].filter(Boolean);
    if (!hashes.length) return res.json({ ok: true });
    if (!pinOk(pin) || !hashes.some((h) => auth.checkPassword(pin, h))) {
      return res.status(403).json({ error: 'bad_pin', message: 'Wrong PIN.' });
    }
    if (account) await query(`UPDATE users SET parental = '{}'::jsonb WHERE id = $1`, [req.user.id]);
    clearLock(res);
    res.json({ ok: true });
  });

  app.post('/api/parental/verify', authLimiter, async (req, res) => {
    const pin = String(req.body.pin || '');
    const hashes = [req.user?.parental?.enabled && req.user.parental.pinHash, readLock(req)?.pinHash].filter(Boolean);
    const ok = pinOk(pin) && hashes.some((h) => auth.checkPassword(pin, h));
    res.status(ok ? 200 : 403).json({ ok, message: ok ? undefined : 'Wrong PIN.' });
  });

  // ---------- videos ----------

  app.get('/api/home', async (req, res) => {
    const f = await filtersFor(req);
    const cond = videoConditions(f).join(' AND ');
    const featured = await many(
      `SELECT ${VIDEO_COLUMNS} FROM videos v LEFT JOIN categories c ON c.id = v.category_id
       WHERE ${cond} AND v.featured ORDER BY v.published_at DESC LIMIT 6`,
    );
    const rows = await many(
      `SELECT * FROM (
         SELECT ${VIDEO_COLUMNS}, c.sort AS cat_sort,
           row_number() OVER (PARTITION BY v.category_id ORDER BY v.published_at DESC) AS rn
         FROM videos v JOIN categories c ON c.id = v.category_id WHERE ${cond}
       ) t WHERE rn <= 12 ORDER BY cat_sort, published_at DESC`,
    );
    const sections = [];
    for (const r of rows) {
      let sec = sections.find((s) => s.slug === r.cat_slug);
      if (!sec) sections.push((sec = { slug: r.cat_slug, nameEn: r.cat_en, nameYi: r.cat_yi, videos: [] }));
      sec.videos.push(videoDto(r));
    }
    const latest = await many(
      `SELECT ${VIDEO_COLUMNS} FROM videos v LEFT JOIN categories c ON c.id = v.category_id
       WHERE ${cond} ORDER BY v.published_at DESC LIMIT 12`,
    );
    const originals = await many(
      `SELECT ${VIDEO_COLUMNS} FROM videos v LEFT JOIN categories c ON c.id = v.category_id
       WHERE ${cond} AND v.source = 'upload' ORDER BY v.published_at DESC LIMIT 16`,
    );
    res.json({
      featured: featured.map(videoDto),
      originals: originals.map(videoDto),
      sections,
      latest: latest.map(videoDto),
      ads: await pickAds(req, 'banner', 2),
    });
  });

  app.get('/api/videos', async (req, res) => {
    const f = await filtersFor(req);
    const p = new Params();
    const cond = videoConditions(f);
    if (req.query.category) cond.push(`c.slug = ${p.add(String(req.query.category))}`);
    const limit = Math.min(48, Math.max(1, Number(req.query.limit) || 24));
    const offset = Math.max(0, Number(req.query.offset) || 0);
    const rows = await many(
      `SELECT ${VIDEO_COLUMNS} FROM videos v LEFT JOIN categories c ON c.id = v.category_id
       WHERE ${cond.join(' AND ')} ORDER BY v.published_at DESC LIMIT ${limit + 1} OFFSET ${offset}`,
      p.values,
    );
    res.json({ videos: rows.slice(0, limit).map(videoDto), more: rows.length > limit });
  });

  app.get('/api/videos/:id', async (req, res) => {
    const id = idParam(req);
    const f = await filtersFor(req);
    const me = req.user ? req.user.id : 0;
    const r =
      id &&
      (await one(
        `SELECT ${VIDEO_COLUMNS},
           EXISTS (SELECT 1 FROM saved s WHERE s.video_id = v.id AND s.user_id = $2) AS is_saved,
           EXISTS (SELECT 1 FROM likes l WHERE l.video_id = v.id AND l.user_id = $2) AS is_liked
         FROM videos v LEFT JOIN categories c ON c.id = v.category_id WHERE v.id = $1`,
        [id, me],
      ));
    const isAdmin = req.user?.role === 'admin';
    if (!r || (r.status !== 'published' && !isAdmin)) return res.status(404).json({ error: 'not_found', message: 'Video not found.' });
    const allowed = await one(
      `SELECT 1 FROM videos v WHERE v.id = $1 AND ${videoConditions(f).join(' AND ')}`,
      [id],
    );
    if (!allowed && !isAdmin) {
      return res.status(403).json({ error: 'filtered', message: 'This video is hidden by parental controls.' });
    }
    const related = await many(
      `SELECT ${VIDEO_COLUMNS} FROM videos v LEFT JOIN categories c ON c.id = v.category_id
       WHERE ${videoConditions(f).join(' AND ')} AND v.id <> $1
       ORDER BY (v.category_id IS NOT DISTINCT FROM $2) DESC, v.published_at DESC LIMIT 12`,
      [id, r.category_id],
    );
    res.json({
      video: videoDto(r),
      related: related.map(videoDto),
      ads: await pickAds(req, 'watch', 1),
      canDownload: r.source === 'upload' && (isPremium(req.user) || isAdmin),
    });
  });

  app.post('/api/videos/:id/view', async (req, res) => {
    const id = idParam(req);
    if (id) await query(`UPDATE videos SET views = views + 1 WHERE id = $1 AND status = 'published'`, [id]);
    res.json({ ok: true });
  });

  for (const [action, table] of [
    ['save', 'saved'],
    ['like', 'likes'],
  ]) {
    const handler = async (req, res) => {
      const id = idParam(req);
      if (!id || !(await one(`SELECT 1 FROM videos WHERE id = $1 AND status = 'published'`, [id]))) {
        return res.status(404).json({ error: 'not_found', message: 'Video not found.' });
      }
      if (req.method === 'POST') {
        await query(`INSERT INTO ${table} (user_id, video_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [req.user.id, id]);
      } else {
        await query(`DELETE FROM ${table} WHERE user_id = $1 AND video_id = $2`, [req.user.id, id]);
      }
      const r = await one(
        `SELECT (SELECT COUNT(*)::int FROM likes WHERE video_id = $1) AS likes,
                EXISTS (SELECT 1 FROM saved WHERE video_id = $1 AND user_id = $2) AS saved,
                EXISTS (SELECT 1 FROM likes WHERE video_id = $1 AND user_id = $2) AS liked`,
        [id, req.user.id],
      );
      res.json(r);
    };
    app.post(`/api/videos/:id/${action}`, auth.requireAuth, handler);
    app.delete(`/api/videos/:id/${action}`, auth.requireAuth, handler);
  }

  app.get('/api/search', async (req, res) => {
    const q = String(req.query.q || '').trim().slice(0, 80);
    if (!q) return res.json({ videos: [], creators: [] });
    const f = await filtersFor(req);
    const like = '%' + q.replace(/[\\%_]/g, '\\$&') + '%';
    const videos = await many(
      `SELECT ${VIDEO_COLUMNS} FROM videos v LEFT JOIN categories c ON c.id = v.category_id
       WHERE ${videoConditions(f).join(' AND ')}
         AND (v.title ILIKE $1 OR v.channel_name ILIKE $1 OR v.description ILIKE $1)
       ORDER BY v.published_at DESC LIMIT 48`,
      [like],
    );
    const creators = f.hideShorts
      ? []
      : await many(
          `SELECT u.* FROM users u WHERE (u.username ILIKE $1 OR u.display_name ILIKE $1)
             AND NOT u.banned AND EXISTS (SELECT 1 FROM statuses s WHERE s.user_id = u.id AND s.status = 'published')
           ORDER BY u.verified DESC, u.username LIMIT 12`,
          [like],
        );
    res.json({ videos: videos.map(videoDto), creators: creators.map(userDto) });
  });

  // ---------- statuses ----------

  app.get('/api/statuses', async (req, res) => {
    const f = await filtersFor(req);
    const { from, to } = parseRange(req);
    const me = req.user ? req.user.id : 0;
    const p = new Params();
    const meP = p.add(me);
    const cond = statusConditions(f);
    cond.push(`s.created_at >= ${p.add(from)}`, `s.created_at < ${p.add(to)}`, 'NOT u.banned');
    if (req.query.tab === 'following') cond.push(`EXISTS (SELECT 1 FROM follows fo WHERE fo.user_id = ${meP} AND fo.creator_id = u.id)`);
    const rows = await many(
      `SELECT u.username, u.display_name, u.avatar_media_id, u.verified,
         COUNT(*)::int AS count, MAX(s.created_at) AS latest,
         array_agg(s.id ORDER BY s.created_at) AS ids,
         COUNT(*) FILTER (WHERE sv.user_id IS NULL)::int AS unseen,
         (array_agg(s.kind ORDER BY s.created_at DESC))[1] AS last_kind,
         (array_agg(s.body ORDER BY s.created_at DESC))[1] AS last_body
       FROM statuses s JOIN users u ON u.id = s.user_id
       LEFT JOIN status_views sv ON sv.status_id = s.id AND sv.user_id = ${meP}
       WHERE ${cond.join(' AND ')}
       GROUP BY u.id ORDER BY latest DESC LIMIT 300`,
      p.values,
    );
    res.json({
      creators: rows.map((r) => ({
        user: userDto(r),
        count: r.count,
        unseen: r.unseen,
        ids: r.ids,
        latestAt: ms(r.latest),
        preview: { kind: r.last_kind, text: (r.last_body || '').slice(0, 90) },
      })),
    });
  });

  app.get('/api/statuses/by/:username', async (req, res) => {
    const f = await filtersFor(req);
    const { from, to } = parseRange(req);
    const me = req.user ? req.user.id : 0;
    const rows = await many(
      `SELECT s.*, u.username, u.display_name, u.avatar_media_id, u.verified,
         EXISTS (SELECT 1 FROM status_views sv WHERE sv.status_id = s.id AND sv.user_id = $4) AS seen
       FROM statuses s JOIN users u ON u.id = s.user_id
       WHERE lower(u.username) = lower($1) AND s.created_at >= $2 AND s.created_at < $3
         AND ${statusConditions(f).join(' AND ')}
       ORDER BY s.created_at`,
      [req.params.username, from, to, me],
    );
    res.json({ statuses: rows.map((r) => ({ ...statusDto(r), seen: r.seen })), ads: await pickAds(req, 'status', 1) });
  });

  app.get('/api/shorts', async (req, res) => {
    const f = await filtersFor(req);
    const p = new Params();
    const cond = statusConditions(f);
    cond.push(`s.kind = 'video'`, 'NOT u.banned');
    const before = Number(req.query.before);
    if (Number.isInteger(before) && before > 0) cond.push(`s.id < ${p.add(before)}`);
    const rows = await many(
      `SELECT s.*, u.username, u.display_name, u.avatar_media_id, u.verified
       FROM statuses s JOIN users u ON u.id = s.user_id
       WHERE ${cond.join(' AND ')} ORDER BY s.id DESC LIMIT 10`,
      p.values,
    );
    res.json({ shorts: rows.map(statusDto), ads: await pickAds(req, 'status', 2), done: rows.length < 10 });
  });

  app.post('/api/statuses', auth.requireAuth, writeLimiter, single('file'), async (req, res) => {
    // Shorts are always videos.
    const kind = 'video';
    const body = String(req.body.body || '').trim().slice(0, 500);
    const bg = STATUS_BGS[0];
    if (!req.file) return res.status(400).json({ error: 'no_file', message: 'Choose a video to post.' });
    const m = await storeMedia(req.file.buffer, req.user.id);
    if (!m || !VIDEO_TYPES.includes(m.mime)) {
      if (m) await deleteMedia(m.id);
      return res.status(400).json({ error: 'bad_type', message: 'Shorts must be a video (MP4, WebM or MOV).' });
    }
    const mediaId = m.id;
    const autoPublish = req.user.verified || req.user.role === 'admin';
    const r = await one(
      `INSERT INTO statuses (user_id, kind, body, bg, media_id, has_music, women_singing, women_images, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [
        req.user.id,
        kind,
        body,
        bg,
        mediaId,
        bool(req.body.music),
        bool(req.body.womenSinging),
        bool(req.body.womenImages),
        autoPublish ? 'published' : 'pending',
      ],
    );
    res.status(201).json({ status: statusDto(r), pending: !autoPublish });
  });

  app.get('/api/me/statuses', auth.requireAuth, async (req, res) => {
    const rows = await many('SELECT * FROM statuses WHERE user_id = $1 ORDER BY created_at DESC LIMIT 100', [req.user.id]);
    res.json({ statuses: rows.map(statusDto) });
  });

  app.post('/api/statuses/:id/view', async (req, res) => {
    const id = idParam(req);
    if (!id) return res.status(404).json({ error: 'not_found' });
    if (req.user) {
      const ins = await query(
        'INSERT INTO status_views (user_id, status_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [req.user.id, id],
      );
      if (ins.affectedRows || ins.rowCount) await query('UPDATE statuses SET views = views + 1 WHERE id = $1', [id]);
    } else {
      await query('UPDATE statuses SET views = views + 1 WHERE id = $1', [id]);
    }
    res.json({ ok: true });
  });

  app.delete('/api/statuses/:id', auth.requireAuth, async (req, res) => {
    const id = idParam(req);
    const s = id && (await one('SELECT * FROM statuses WHERE id = $1', [id]));
    if (!s) return res.status(404).json({ error: 'not_found', message: 'Status not found.' });
    if (s.user_id !== req.user.id && req.user.role !== 'admin') return res.status(403).json({ error: 'forbidden' });
    await query('DELETE FROM statuses WHERE id = $1', [id]);
    await deleteMedia(s.media_id);
    res.json({ ok: true });
  });

  // ---------- creators ----------

  app.get('/api/creators/:username', async (req, res) => {
    const u = await one('SELECT * FROM users WHERE lower(username) = lower($1) AND NOT banned', [req.params.username]);
    if (!u) return res.status(404).json({ error: 'not_found', message: 'Creator not found.' });
    const f = await filtersFor(req);
    const me = req.user ? req.user.id : 0;
    const stats = await one(
      `SELECT (SELECT COUNT(*)::int FROM follows WHERE creator_id = $1) AS followers,
              EXISTS (SELECT 1 FROM follows WHERE creator_id = $1 AND user_id = $2) AS following`,
      [u.id, me],
    );
    const statuses = await many(
      `SELECT s.*, u.username, u.display_name, u.avatar_media_id, u.verified FROM statuses s JOIN users u ON u.id = s.user_id
       WHERE s.user_id = $1 AND ${statusConditions(f).join(' AND ')} ORDER BY s.created_at DESC LIMIT 60`,
      [u.id],
    );
    const videos = await many(
      `SELECT ${VIDEO_COLUMNS} FROM videos v LEFT JOIN categories c ON c.id = v.category_id
       WHERE v.creator_id = $1 AND ${videoConditions(f).join(' AND ')} ORDER BY v.published_at DESC LIMIT 100`,
      [u.id],
    );
    res.json({
      creator: { ...userDto(u), bio: u.bio, followers: stats.followers, following: stats.following, isMe: me === u.id, isCreator: u.creator_status === 'approved' },
      statuses: statuses.map(statusDto),
      videos: videos.map(videoDto),
    });
  });

  const followHandler = async (req, res) => {
    const u = await one('SELECT id FROM users WHERE lower(username) = lower($1)', [req.params.username]);
    if (!u) return res.status(404).json({ error: 'not_found', message: 'Creator not found.' });
    if (u.id === req.user.id) return res.status(400).json({ error: 'self', message: "You can't add yourself." });
    if (req.method === 'POST') {
      await query('INSERT INTO follows (user_id, creator_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [req.user.id, u.id]);
    } else {
      await query('DELETE FROM follows WHERE user_id = $1 AND creator_id = $2', [req.user.id, u.id]);
    }
    res.json({ following: req.method === 'POST' });
  };
  app.post('/api/creators/:username/follow', auth.requireAuth, followHandler);
  app.delete('/api/creators/:username/follow', auth.requireAuth, followHandler);

  // ---------- ads ----------

  app.get('/api/ads', async (req, res) => {
    const placement = ['banner', 'watch', 'status'].includes(req.query.placement) ? req.query.placement : 'banner';
    res.json({ ads: await pickAds(req, placement, Math.min(3, Number(req.query.n) || 1)) });
  });

  app.post('/api/ads/:id/impression', async (req, res) => {
    const id = idParam(req);
    if (id) await query('UPDATE ads SET impressions = impressions + 1 WHERE id = $1', [id]);
    res.json({ ok: true });
  });

  app.get('/api/ads/:id/click', async (req, res) => {
    const id = idParam(req);
    const ad = id && (await one('UPDATE ads SET clicks = clicks + 1 WHERE id = $1 RETURNING link_url', [id]));
    const link = ad && /^https?:\/\//i.test(ad.link_url) ? ad.link_url : '/';
    res.redirect(302, link);
  });

  // ---------- reports ----------

  app.post('/api/reports', writeLimiter, async (req, res) => {
    const type = ['video', 'status'].includes(req.body.type) ? req.body.type : null;
    const id = Number(req.body.id);
    if (!type || !Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'bad_report' });
    await query('INSERT INTO reports (user_id, target_type, target_id, reason) VALUES ($1, $2, $3, $4)', [
      req.user ? req.user.id : null,
      type,
      id,
      String(req.body.reason || '').trim().slice(0, 300),
    ]);
    res.status(201).json({ ok: true });
  });

  // ---------- premium ----------

  const baseUrl = (req) => process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`;

  app.post('/api/premium/checkout', auth.requireAuth, async (req, res, next) => {
    if (!stripe.paymentsEnabled()) {
      return res.status(503).json({ error: 'payments_off', message: 'Payments are not set up yet.' });
    }
    try {
      const s = await stripe.createCheckout({ userId: req.user.id, customerId: req.user.stripe_customer_id, baseUrl: baseUrl(req) });
      res.json({ url: s.url });
    } catch (err) {
      next(err);
    }
  });

  app.post('/api/premium/portal', auth.requireAuth, async (req, res, next) => {
    if (!stripe.paymentsEnabled() || !req.user.stripe_customer_id) {
      return res.status(400).json({ error: 'no_billing', message: 'No subscription to manage.' });
    }
    try {
      const s = await stripe.createPortal({ customerId: req.user.stripe_customer_id, baseUrl: baseUrl(req) });
      res.json({ url: s.url });
    } catch (err) {
      next(err);
    }
  });

  // ---------- admin ----------

  app.use('/api/admin', auth.requireAdmin, adminRouter({ single }));
  app.use('/api/creator', creatorRouter({ uploadPoster: single('poster'), writeLimiter }));

  // ---------- media + static ----------

  app.get('/media/:id', async (req, res, next) => {
    try {
      const allowDownload = isPremium(req.user);
      await serveMedia(req, res, { allowDownload });
    } catch (err) {
      next(err);
    }
  });

  app.use(express.static(PUBLIC_DIR, { maxAge: IS_PROD ? '1h' : 0 }));
  app.use('/api', (_req, res) => res.status(404).json({ error: 'not_found', message: 'Not found.' }));
  app.use((_req, res) => res.status(404).sendFile(path.join(PUBLIC_DIR, 'index.html')));

  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'bad_json', message: 'Invalid request.' });
    if (!err.status || err.status >= 500) console.error(err);
    res.status(err.status && err.status < 600 ? err.status : 500).json({
      error: 'server_error',
      message: err.status && err.status < 500 ? err.message : 'Something went wrong on our side.',
    });
  });

  return app;
}
