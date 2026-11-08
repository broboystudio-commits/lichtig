// First-run content: categories, the admin account, a starter set of YouTube videos,
// demo creators with statuses, and two placeholder ads. Safe to run on every start.

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { one, many, query } from './db.js';
import { hashPassword } from './auth.js';
import { storeMedia } from './media.js';
import { thumbUrl } from './youtube.js';

const SEED_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'seed');

export const CATEGORIES = [
  ['torah', 'Torah & Shiurim', 'תורה און שיעורים'],
  ['music', 'Music', 'מוזיק'],
  ['kids', 'Kids', 'קינדער'],
  ['chizuk', 'Chizuk', 'חיזוק'],
  ['history', 'History', 'היסטאריע'],
  ['simcha', 'Simchas & Yom Tov', 'שמחות און יום טוב'],
  ['cooking', 'Cooking', 'קאכן'],
  ['news', 'News', 'נייעס'],
  ['comedy', 'Comedy', 'הומאר'],
];

async function ensureCategories() {
  let sort = 0;
  for (const [slug, en, yi] of CATEGORIES) {
    await query(
      `INSERT INTO categories (slug, name_en, name_yi, sort) VALUES ($1, $2, $3, $4) ON CONFLICT (slug) DO NOTHING`,
      [slug, en, yi, sort++],
    );
  }
}

async function ensureAdmin() {
  const username = process.env.ADMIN_USERNAME || 'admin';
  const password = process.env.ADMIN_PASSWORD;
  const existing = await one('SELECT id FROM users WHERE lower(username) = lower($1)', [username]);
  if (password) {
    if (existing) {
      await query(`UPDATE users SET role = 'admin', verified = TRUE, password_hash = $2, banned = FALSE WHERE id = $1`, [
        existing.id,
        hashPassword(password),
      ]);
    } else {
      await query(
        `INSERT INTO users (username, display_name, password_hash, role, verified) VALUES ($1, 'Lichtig Admin', $2, 'admin', TRUE)`,
        [username, hashPassword(password)],
      );
    }
    return;
  }
  if (!(await one(`SELECT 1 FROM users WHERE role = 'admin'`))) {
    const generated = crypto.randomBytes(9).toString('base64url');
    await query(
      `INSERT INTO users (username, display_name, password_hash, role, verified) VALUES ($1, 'Lichtig Admin', $2, 'admin', TRUE)
       ON CONFLICT DO NOTHING`,
      [username, hashPassword(generated)],
    );
    console.log(`\n  Admin account created → username: ${username}  password: ${generated}\n  (set ADMIN_PASSWORD to choose your own)\n`);
  }
}

async function seedVideos() {
  if ((await one('SELECT COUNT(*)::int AS n FROM videos')).n > 0) return;
  const file = path.join(SEED_DIR, 'youtube.json');
  if (!fs.existsSync(file)) return;
  const list = JSON.parse(fs.readFileSync(file, 'utf8'));
  const cats = new Map((await many('SELECT id, slug FROM categories')).map((c) => [c.slug, c.id]));
  let i = 0;
  for (const v of list) {
    // Stagger publish times so "latest" has a natural order.
    const publishedAt = new Date(Date.now() - (i++ * 5 + 30) * 60 * 1000);
    await query(
      `INSERT INTO videos (source, yt_id, title, channel_name, thumbnail_url, category_id, kid_safe, has_music,
         women_singing, women_images, is_news, status, featured, published_at)
       VALUES ('youtube', $1, $2, $3, $4, $5, $6, $7, FALSE, $8, FALSE, 'published', $9, $10)
       ON CONFLICT (yt_id) DO NOTHING`,
      [v.id, v.title, v.channel, thumbUrl(v.id), cats.get(v.category) || null, !!v.kidSafe, !!v.music, !!v.womenImages, !!v.featured, publishedAt],
    );
  }
}

async function seedFile(name, ownerId) {
  const p = path.join(SEED_DIR, name);
  if (!fs.existsSync(p)) return null;
  const m = await storeMedia(fs.readFileSync(p), ownerId);
  return m ? m.id : null;
}

async function seedStatuses() {
  if ((await one('SELECT COUNT(*)::int AS n FROM statuses')).n > 0) return;
  const creators = [
    ['lichtig', 'Lichtig', 'The official Lichtig channel.'],
    ['dailychizuk', 'Daily Chizuk', 'A little chizuk every day.'],
    ['heimishvibes', 'Heimish Vibes', 'Simchas, niggunim and good news.'],
  ];
  const ids = {};
  for (const [username, name, bio] of creators) {
    const u = await one(
      `INSERT INTO users (username, display_name, password_hash, verified, bio) VALUES ($1, $2, $3, TRUE, $4)
       ON CONFLICT DO NOTHING RETURNING id`,
      [username, name, hashPassword(crypto.randomBytes(18).toString('hex')), bio],
    );
    ids[username] = u ? u.id : (await one('SELECT id FROM users WHERE lower(username) = $1', [username])).id;
  }
  const H = 3600 * 1000;
  const posts = [
    [ids.lichtig, 'text', 'Welcome to Lichtig! Watch kosher videos, follow your favorite creators, and set parental controls for your family.', '#123b7a', null, 0.5],
    [ids.lichtig, 'text', 'ברוכים הבאים צו ליכטיג! קוקט כשר׳ע ווידיאוס און סטאטוסן.', '#065f46', null, 0.4],
    [ids.dailychizuk, 'video', 'Ein Od Milvado', null, 'status-einod.mp4', 1.5],
    [ids.dailychizuk, 'image', 'Gam zu l’tovah', null, 'status-gamzu.jpg', 3],
    [ids.dailychizuk, 'text', '“Know where you came from, where you are going, and before Whom you will give an accounting.” (Pirkei Avos 3:1)', '#7c2d12', null, 26],
    [ids.heimishvibes, 'video', 'A Gut Voch to everyone!', null, 'status-gutvoch.mp4', 2],
    [ids.heimishvibes, 'image', 'Shabbos is on its way', null, 'status-shabbos.jpg', 28],
    [ids.heimishvibes, 'text', 'א גוטע וואך! א וואך פון געזונט, פרנסה און נחת.', '#6b21a8', null, 50],
  ];
  for (const [userId, kind, body, bg, file, hoursAgo] of posts) {
    const mediaId = file ? await seedFile(file, userId) : null;
    if (file && !mediaId) continue;
    await query(
      `INSERT INTO statuses (user_id, kind, body, bg, media_id, kid_safe, status, created_at)
       VALUES ($1, $2, $3, $4, $5, TRUE, 'published', $6)`,
      [userId, kind, body, bg || '#123b7a', mediaId, new Date(Date.now() - hoursAgo * H)],
    );
  }
}

async function seedAds() {
  if ((await one('SELECT COUNT(*)::int AS n FROM ads')).n > 0) return;
  for (const [file, title, placement] of [
    ['ad-banner.jpg', 'Advertise on Lichtig (sample)', 'banner'],
    ['ad-status.jpg', 'Advertise on Lichtig (sample status ad)', 'status'],
  ]) {
    const mediaId = await seedFile(file, null);
    if (mediaId) {
      await query(`INSERT INTO ads (title, media_id, link_url, placement) VALUES ($1, $2, '', $3)`, [title, mediaId, placement]);
    }
  }
}

export async function seed({ demoContent = true } = {}) {
  await ensureCategories();
  await ensureAdmin();
  if (demoContent) {
    await seedVideos();
    await seedStatuses();
    await seedAds();
  }
}
