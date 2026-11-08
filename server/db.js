// Database access. Uses real Postgres when DATABASE_URL is set (Render), otherwise an
// embedded Postgres (PGlite) so the app and tests run anywhere with zero setup.

import fs from 'fs';
import path from 'path';

let impl = null;

export async function initDb({ memory = false } = {}) {
  if (impl) return impl;
  if (process.env.DATABASE_URL && !memory) {
    const { default: pg } = await import('pg');
    const ssl = process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : undefined;
    const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl, max: 8 });
    impl = {
      kind: 'postgres',
      query: (text, params) => pool.query(text, params),
      async tx(fn) {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          const out = await fn({ query: (t, p) => client.query(t, p) });
          await client.query('COMMIT');
          return out;
        } catch (err) {
          await client.query('ROLLBACK');
          throw err;
        } finally {
          client.release();
        }
      },
      close: () => pool.end(),
    };
  } else {
    const { PGlite } = await import('@electric-sql/pglite');
    let dataDir;
    if (!memory) {
      dataDir = path.resolve(process.env.DATA_DIR || 'data', 'pglite');
      fs.mkdirSync(dataDir, { recursive: true });
    }
    const db = await PGlite.create(dataDir);
    impl = {
      kind: 'pglite',
      query: (text, params) => db.query(text, params),
      tx: (fn) => db.transaction((t) => fn({ query: (a, b) => t.query(a, b) })),
      close: () => db.close(),
    };
  }
  await migrate();
  return impl;
}

export const query = (text, params) => impl.query(text, params);
export const many = async (text, params) => (await impl.query(text, params)).rows;
export const one = async (text, params) => (await impl.query(text, params)).rows[0] || null;
export const tx = (fn) => impl.tx(fn);
export const closeDb = async () => {
  if (impl) await impl.close();
  impl = null;
};
export const dbKind = () => impl && impl.kind;

/** bytea comes back as Buffer (pg) or Uint8Array (PGlite); normalise to Buffer. */
export function toBuffer(v) {
  if (!v) return Buffer.alloc(0);
  return Buffer.isBuffer(v) ? v : Buffer.from(v.buffer, v.byteOffset, v.byteLength);
}

export const ms = (d) => (d ? new Date(d).getTime() : null);

async function migrate() {
  const statements = `
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  username TEXT NOT NULL,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user',
  verified BOOLEAN NOT NULL DEFAULT FALSE,
  is_premium BOOLEAN NOT NULL DEFAULT FALSE,
  premium_source TEXT,
  stripe_customer_id TEXT,
  stripe_subscription_id TEXT,
  avatar_media_id INTEGER,
  bio TEXT NOT NULL DEFAULT '',
  lang TEXT NOT NULL DEFAULT 'en',
  parental JSONB NOT NULL DEFAULT '{}'::jsonb,
  banned BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS users_username_lower ON users (lower(username));

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS media (
  id SERIAL PRIMARY KEY,
  owner_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  data BYTEA NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS categories (
  id SERIAL PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name_en TEXT NOT NULL,
  name_yi TEXT NOT NULL,
  sort INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS channels (
  id SERIAL PRIMARY KEY,
  url TEXT NOT NULL UNIQUE,
  yt_channel_id TEXT,
  name TEXT NOT NULL,
  thumbnail_url TEXT NOT NULL DEFAULT '',
  category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  trusted BOOLEAN NOT NULL DEFAULT FALSE,
  last_synced_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS videos (
  id SERIAL PRIMARY KEY,
  source TEXT NOT NULL DEFAULT 'youtube',
  yt_id TEXT UNIQUE,
  media_id INTEGER REFERENCES media(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  channel_id INTEGER REFERENCES channels(id) ON DELETE SET NULL,
  channel_name TEXT NOT NULL DEFAULT '',
  thumbnail_url TEXT NOT NULL DEFAULT '',
  duration_s INTEGER,
  category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  kid_safe BOOLEAN NOT NULL DEFAULT FALSE,
  has_music BOOLEAN NOT NULL DEFAULT FALSE,
  women_singing BOOLEAN NOT NULL DEFAULT FALSE,
  women_images BOOLEAN NOT NULL DEFAULT FALSE,
  is_news BOOLEAN NOT NULL DEFAULT FALSE,
  status TEXT NOT NULL DEFAULT 'pending',
  featured BOOLEAN NOT NULL DEFAULT FALSE,
  views INTEGER NOT NULL DEFAULT 0,
  added_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  published_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS videos_status_pub ON videos (status, published_at DESC);
CREATE INDEX IF NOT EXISTS videos_category ON videos (category_id);

CREATE TABLE IF NOT EXISTS statuses (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  bg TEXT NOT NULL DEFAULT '#123b7a',
  media_id INTEGER REFERENCES media(id) ON DELETE SET NULL,
  has_music BOOLEAN NOT NULL DEFAULT FALSE,
  women_singing BOOLEAN NOT NULL DEFAULT FALSE,
  women_images BOOLEAN NOT NULL DEFAULT FALSE,
  kid_safe BOOLEAN NOT NULL DEFAULT FALSE,
  status TEXT NOT NULL DEFAULT 'pending',
  views INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS statuses_pub ON statuses (status, created_at DESC);
CREATE INDEX IF NOT EXISTS statuses_user ON statuses (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS status_views (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status_id INTEGER NOT NULL REFERENCES statuses(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, status_id)
);

CREATE TABLE IF NOT EXISTS follows (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  creator_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, creator_id)
);

CREATE TABLE IF NOT EXISTS saved (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  video_id INTEGER NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, video_id)
);

CREATE TABLE IF NOT EXISTS likes (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  video_id INTEGER NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, video_id)
);

CREATE TABLE IF NOT EXISTS ads (
  id SERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  media_id INTEGER REFERENCES media(id) ON DELETE SET NULL,
  link_url TEXT NOT NULL DEFAULT '',
  placement TEXT NOT NULL DEFAULT 'banner',
  active BOOLEAN NOT NULL DEFAULT TRUE,
  starts_at TIMESTAMPTZ,
  ends_at TIMESTAMPTZ,
  weight INTEGER NOT NULL DEFAULT 1,
  impressions INTEGER NOT NULL DEFAULT 0,
  clicks INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS reports (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  target_type TEXT NOT NULL,
  target_id INTEGER NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  resolved BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL
);

ALTER TABLE users ADD COLUMN IF NOT EXISTS show_women_images BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS show_women_singing BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS creator_status TEXT NOT NULL DEFAULT 'none';
ALTER TABLE users ADD COLUMN IF NOT EXISTS creator_note TEXT NOT NULL DEFAULT '';

ALTER TABLE media ALTER COLUMN data DROP NOT NULL;
ALTER TABLE media ADD COLUMN IF NOT EXISTS storage TEXT NOT NULL DEFAULT 'db';
ALTER TABLE media ADD COLUMN IF NOT EXISTS object_key TEXT;

ALTER TABLE videos ADD COLUMN IF NOT EXISTS creator_id INTEGER REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE videos ADD COLUMN IF NOT EXISTS poster_media_id INTEGER REFERENCES media(id) ON DELETE SET NULL;
ALTER TABLE videos ADD COLUMN IF NOT EXISTS rights_note TEXT NOT NULL DEFAULT '';
ALTER TABLE videos ADD COLUMN IF NOT EXISTS source_url TEXT NOT NULL DEFAULT '';
ALTER TABLE videos ADD COLUMN IF NOT EXISTS import_error TEXT NOT NULL DEFAULT '';
ALTER TABLE channels ADD COLUMN IF NOT EXISTS auto_sync BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE channels ADD COLUMN IF NOT EXISTS sync_error TEXT NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS videos_creator ON videos (creator_id);

DELETE FROM media WHERE id IN (SELECT media_id FROM statuses WHERE kind <> 'video' AND media_id IS NOT NULL);
DELETE FROM statuses WHERE kind <> 'video';
`;
  for (const stmt of statements.split(/;\s*\n/).map((s) => s.trim()).filter(Boolean)) {
    await impl.query(stmt);
  }
}

// ---------- settings ----------

export const DEFAULT_SETTINGS = {
  siteName: 'Lichtig',
  shabbos: { enabled: true, city: 'New York' },
  musicPeriods: false,
  premiumPrice: '$4.99 / month',
  announcement: '',
};

export async function getSettings() {
  const rows = await many('SELECT key, value FROM settings');
  const out = structuredClone(DEFAULT_SETTINGS);
  for (const r of rows) out[r.key] = r.value;
  return out;
}

export async function setSetting(key, value) {
  await query(
    `INSERT INTO settings (key, value) VALUES ($1, $2::jsonb)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
    [key, JSON.stringify(value)],
  );
}
