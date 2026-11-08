import express from 'express';
import { query, one, many, getSettings, setSetting, ms, tx } from './db.js';
import { storeMedia, deleteMedia, mediaUrl, IMAGE_TYPES, VIDEO_TYPES } from './media.js';
import * as yt from './youtube.js';
import { CITIES } from './jewish.js';
import { paymentsEnabled } from './stripe.js';
import { startImport, normalizeLink } from './importer.js';
import { storageEnabled } from './storage.js';

// Late imports from app.js would be circular; these helpers are small enough to repeat.
const idParam = (req) => {
  const n = Number(req.params.id);
  return Number.isInteger(n) && n > 0 ? n : null;
};
const bool = (v) => v === true || v === 'true' || v === '1' || v === 'on' || v === 1;

export function flagsFrom(src = {}) {
  return {
    kid_safe: bool(src.kidSafe),
    has_music: bool(src.music),
    women_singing: bool(src.womenSinging),
    women_images: bool(src.womenImages),
    is_news: bool(src.news),
  };
}

async function categoryId(slug) {
  if (!slug) return null;
  const c = await one('SELECT id FROM categories WHERE slug = $1', [String(slug)]);
  return c ? c.id : null;
}

async function upsertChannel(url, name) {
  if (!url) return null;
  const c = await one(
    `INSERT INTO channels (url, name) VALUES ($1, $2)
     ON CONFLICT (url) DO UPDATE SET name = excluded.name RETURNING id`,
    [url, name || url],
  );
  return c.id;
}

/** Add one YouTube video (by id). Returns { id, existed } or throws if it can't be embedded. */
export async function importYouTube(ytId, { categoryId: catId = null, flags = {}, status = 'pending', addedBy = null, channelId = null, details = null } = {}) {
  const existing = await one('SELECT id FROM videos WHERE yt_id = $1', [ytId]);
  if (existing) return { id: existing.id, existed: true };

  let info = details && details.get(ytId);
  if (!info && yt.hasApiKey()) info = (await yt.videoDetails([ytId])).get(ytId);
  if (info && info.embeddable === false) throw Object.assign(new Error('This video does not allow embedding.'), { status: 400 });
  const o = await yt.oembed(ytId); // confirms the video is public and embeddable
  const chId = channelId || (await upsertChannel(o.channelUrl, o.channelName));
  const f = { kid_safe: false, has_music: false, women_singing: false, women_images: false, is_news: false, ...flags };
  const row = await one(
    `INSERT INTO videos (source, yt_id, title, description, channel_id, channel_name, thumbnail_url, duration_s,
       category_id, kid_safe, has_music, women_singing, women_images, is_news, status, added_by, published_at)
     VALUES ('youtube', $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
       CASE WHEN $14 = 'published' THEN now() ELSE NULL END)
     ON CONFLICT (yt_id) DO NOTHING RETURNING id`,
    [
      ytId,
      (info && info.title) || o.title,
      (info && info.description) || '',
      chId,
      o.channelName,
      yt.thumbUrl(ytId),
      info ? info.duration : null,
      catId,
      f.kid_safe,
      f.has_music,
      f.women_singing,
      f.women_images,
      f.is_news,
      status,
      addedBy,
    ],
  );
  if (!row) return { id: (await one('SELECT id FROM videos WHERE yt_id = $1', [ytId])).id, existed: true };
  return { id: row.id, existed: false };
}

export async function syncChannel(channel) {
  if (!yt.hasApiKey()) throw Object.assign(new Error('Add a YouTube API key to sync channels.'), { status: 400 });
  const info = await yt.resolveChannel(channel.url);
  if (!info || !info.uploads) throw Object.assign(new Error('Could not find that channel on YouTube.'), { status: 400 });
  await query('UPDATE channels SET yt_channel_id = $2, name = $3, thumbnail_url = $4, last_synced_at = now() WHERE id = $1', [
    channel.id,
    info.id,
    info.name,
    info.thumbnail,
  ]);
  const ids = await yt.latestUploads(info.uploads, 15);
  const known = new Set((await many('SELECT yt_id FROM videos WHERE yt_id = ANY($1::text[])', [ids])).map((r) => r.yt_id));
  const fresh = ids.filter((id) => !known.has(id));
  const details = await yt.videoDetails(fresh);
  let added = 0;
  for (const id of fresh) {
    try {
      await importYouTube(id, {
        categoryId: channel.category_id,
        status: channel.trusted ? 'published' : 'pending',
        channelId: channel.id,
        details,
      });
      added++;
    } catch {
      /* skip videos that can't be embedded */
    }
  }
  return { added, checked: ids.length };
}

const adminVideoDto = (r) => ({
  id: r.id,
  source: r.source,
  ytId: r.yt_id,
  mediaUrl: mediaUrl(r.media_id),
  title: r.title,
  channelName: r.channel_name,
  thumbnail: r.thumbnail_url || mediaUrl(r.poster_media_id) || null,
  category: r.cat_slug || null,
  status: r.status,
  featured: r.featured,
  views: r.views,
  flags: { kidSafe: r.kid_safe, music: r.has_music, womenSinging: r.women_singing, womenImages: r.women_images, news: r.is_news },
  createdAt: ms(r.created_at),
  rightsNote: r.rights_note || '',
  importError: r.import_error || '',
  creator: r.creator_username || null,
});

export function adminRouter({ single }) {
  const r = express.Router();

  r.get('/stats', async (_req, res) => {
    const s = await one(`SELECT
      (SELECT COUNT(*)::int FROM users) AS users,
      (SELECT COUNT(*)::int FROM users WHERE is_premium) AS premium,
      (SELECT COUNT(*)::int FROM videos WHERE status = 'published') AS videos,
      (SELECT COUNT(*)::int FROM videos WHERE status = 'pending') AS pending_videos,
      (SELECT COUNT(*)::int FROM statuses WHERE status = 'published') AS statuses,
      (SELECT COUNT(*)::int FROM statuses WHERE status = 'pending') AS pending_statuses,
      (SELECT COUNT(*)::int FROM reports WHERE NOT resolved) AS open_reports,
      (SELECT COALESCE(SUM(impressions), 0)::int FROM ads) AS ad_impressions,
      (SELECT COALESCE(SUM(clicks), 0)::int FROM ads) AS ad_clicks,
      (SELECT COALESCE(SUM(size), 0)::bigint FROM media) AS media_bytes,
      (SELECT COUNT(*)::int FROM users WHERE creator_status = 'pending') AS pending_creators,
      (SELECT COUNT(*)::int FROM videos WHERE status IN ('processing', 'failed')) AS importing`);
    res.json({ stats: { ...s, media_bytes: Number(s.media_bytes) }, youtubeApi: yt.hasApiKey(), payments: paymentsEnabled(), storage: storageEnabled() });
  });

  // ---------- videos ----------

  r.get('/videos', async (req, res) => {
    const params = [];
    const cond = ['TRUE'];
    if (req.query.status === 'importing') cond.push(`v.status IN ('processing', 'failed')`);
    else if (['published', 'pending', 'rejected'].includes(req.query.status)) {
      params.push(req.query.status);
      cond.push(`v.status = $${params.length}`);
    }
    if (req.query.q) {
      params.push('%' + String(req.query.q).replace(/[\\%_]/g, '\\$&') + '%');
      cond.push(`(v.title ILIKE $${params.length} OR v.channel_name ILIKE $${params.length})`);
    }
    const offset = Math.max(0, Number(req.query.offset) || 0);
    const rows = await many(
      `SELECT v.*, c.slug AS cat_slug, cu.username AS creator_username FROM videos v
       LEFT JOIN categories c ON c.id = v.category_id LEFT JOIN users cu ON cu.id = v.creator_id
       WHERE ${cond.join(' AND ')} ORDER BY v.created_at DESC LIMIT 51 OFFSET ${offset}`,
      params,
    );
    res.json({ videos: rows.slice(0, 50).map(adminVideoDto), more: rows.length > 50 });
  });

  r.post('/videos/import', async (req, res) => {
    const lines = String(req.body.urls || '')
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 50);
    if (!lines.length) return res.status(400).json({ error: 'empty', message: 'Paste at least one YouTube link.' });
    const catId = await categoryId(req.body.category);
    const flags = flagsFrom(req.body.flags);
    const status = req.body.publish === false ? 'pending' : 'published';
    const ids = lines.map((l) => ({ input: l, id: yt.parseVideoId(l) }));
    const details = await yt.videoDetails(ids.filter((x) => x.id).map((x) => x.id)).catch(() => new Map());
    const results = [];
    for (const { input, id } of ids) {
      if (!id) {
        results.push({ input, ok: false, message: 'Not a YouTube video link' });
        continue;
      }
      try {
        const out = await importYouTube(id, { categoryId: catId, flags, status, addedBy: req.user.id, details });
        results.push({ input, ok: true, id: out.id, existed: out.existed });
      } catch (err) {
        results.push({ input, ok: false, message: err.status === 401 || err.status === 403 ? 'Embedding is turned off for this video' : err.status === 404 ? 'Video not found or private' : err.message });
      }
    }
    res.json({ results });
  });

  r.post('/videos/upload', single('file'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'no_file', message: 'Choose a video file.' });
    const title = String(req.body.title || '').trim().slice(0, 200);
    if (!title) return res.status(400).json({ error: 'no_title', message: 'Give the video a title.' });
    const m = await storeMedia(req.file.buffer, req.user.id);
    if (!m || !VIDEO_TYPES.includes(m.mime)) {
      if (m) await deleteMedia(m.id);
      return res.status(400).json({ error: 'bad_type', message: 'Please choose an MP4, WebM or MOV video.' });
    }
    const f = flagsFrom(req.body);
    const row = await one(
      `INSERT INTO videos (source, media_id, title, description, channel_name, category_id, kid_safe, has_music,
         women_singing, women_images, is_news, status, added_by, published_at)
       VALUES ('upload', $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'published', $11, now()) RETURNING id`,
      [
        m.id,
        title,
        String(req.body.description || '').slice(0, 3000),
        String(req.body.channelName || (await getSettings()).siteName).slice(0, 80),
        await categoryId(req.body.category),
        f.kid_safe,
        f.has_music,
        f.women_singing,
        f.women_images,
        f.is_news,
        req.user.id,
      ],
    );
    res.status(201).json({ id: row.id });
  });

  r.patch('/videos/:id', async (req, res) => {
    const id = idParam(req);
    const v = id && (await one('SELECT * FROM videos WHERE id = $1', [id]));
    if (!v) return res.status(404).json({ error: 'not_found', message: 'Video not found.' });
    const b = req.body;
    const next = {
      title: b.title !== undefined ? String(b.title).trim().slice(0, 200) || v.title : v.title,
      description: b.description !== undefined ? String(b.description).slice(0, 3000) : v.description,
      category_id: b.category !== undefined ? await categoryId(b.category) : v.category_id,
      status: ['published', 'pending', 'rejected'].includes(b.status) ? b.status : v.status,
      featured: b.featured !== undefined ? bool(b.featured) : v.featured,
      ...(b.flags ? flagsFrom(b.flags) : {}),
    };
    const row = await one(
      `UPDATE videos SET title = $2, description = $3, category_id = $4, status = $5, featured = $6,
         kid_safe = $7, has_music = $8, women_singing = $9, women_images = $10, is_news = $11,
         published_at = CASE WHEN $5 = 'published' THEN COALESCE(published_at, now()) ELSE published_at END
       WHERE id = $1 RETURNING *`,
      [
        id,
        next.title,
        next.description,
        next.category_id,
        next.status,
        next.featured,
        next.kid_safe ?? v.kid_safe,
        next.has_music ?? v.has_music,
        next.women_singing ?? v.women_singing,
        next.women_images ?? v.women_images,
        next.is_news ?? v.is_news,
      ],
    );
    const cat = row.category_id ? await one('SELECT slug FROM categories WHERE id = $1', [row.category_id]) : null;
    res.json({ video: adminVideoDto({ ...row, cat_slug: cat && cat.slug }) });
  });

  r.delete('/videos/:id', async (req, res) => {
    const id = idParam(req);
    const v = id && (await one('DELETE FROM videos WHERE id = $1 RETURNING media_id, poster_media_id', [id]));
    if (!v) return res.status(404).json({ error: 'not_found' });
    await deleteMedia(v.media_id);
    await deleteMedia(v.poster_media_id);
    res.json({ ok: true });
  });

  r.post('/videos/import-link', async (req, res) => {
    const b = req.body;
    const title = String(b.title || '').trim().slice(0, 200);
    const rightsNote = String(b.rightsNote || '').trim().slice(0, 300);
    if (!title) return res.status(400).json({ error: 'no_title', message: 'Give the video a title.' });
    if (!rightsNote) return res.status(400).json({ error: 'rights', message: 'Note who gave permission to post this video.' });
    normalizeLink(b.link); // throws a friendly error for unsupported links
    let creatorId = null;
    let channelName = String(b.channelName || '').trim().slice(0, 80);
    if (b.creator) {
      const c = await one('SELECT id, display_name FROM users WHERE lower(username) = lower($1)', [String(b.creator).replace(/^@/, '')]);
      if (!c) return res.status(400).json({ error: 'no_creator', message: 'No user with that username.' });
      creatorId = c.id;
      channelName = channelName || c.display_name;
    }
    const out = await startImport({
      link: b.link,
      title,
      description: String(b.description || '').slice(0, 5000),
      categoryId: await categoryId(b.category),
      flags: flagsFrom(b.flags),
      rightsNote: `Permission: ${rightsNote} (added by @${req.user.username})`,
      creatorId,
      channelName: channelName || (await getSettings()).siteName,
      addedBy: req.user.id,
      publish: b.publish !== false,
    });
    res.status(202).json(out);
  });

  r.get('/creators', async (req, res) => {
    const status = ['pending', 'approved', 'declined'].includes(req.query.status) ? req.query.status : 'pending';
    const rows = await many(
      `SELECT u.*, (SELECT COUNT(*)::int FROM videos v WHERE v.creator_id = u.id) AS video_count
       FROM users u WHERE u.creator_status = $1 ORDER BY u.created_at DESC LIMIT 200`,
      [status],
    );
    res.json({
      creators: rows.map((u) => {
        let note = {};
        try {
          note = JSON.parse(u.creator_note || '{}');
        } catch {
          /* older format */
        }
        return {
          id: u.id,
          username: u.username,
          displayName: u.display_name,
          avatarUrl: mediaUrl(u.avatar_media_id),
          status: u.creator_status,
          channel: note.channel || '',
          about: note.about || '',
          contact: note.contact || '',
          appliedAt: note.at || null,
          videoCount: u.video_count,
        };
      }),
    });
  });

  r.patch('/creators/:id', async (req, res) => {
    const id = idParam(req);
    const status = ['approved', 'declined', 'none'].includes(req.body.status) ? req.body.status : null;
    if (!id || !status) return res.status(400).json({ error: 'bad_request' });
    await query('UPDATE users SET creator_status = $2 WHERE id = $1', [id, status]);
    res.json({ ok: true });
  });

  r.get('/youtube/search', async (req, res) => {
    const q = String(req.query.q || '').trim();
    if (!q) return res.json({ results: [] });
    const results = await yt.search(q);
    const known = new Set(
      (await many('SELECT yt_id FROM videos WHERE yt_id = ANY($1::text[])', [results.map((x) => x.id)])).map((x) => x.yt_id),
    );
    res.json({ results: results.map((x) => ({ ...x, added: known.has(x.id) })) });
  });

  // ---------- channels ----------

  r.get('/channels', async (_req, res) => {
    const rows = await many(
      `SELECT ch.*, c.slug AS cat_slug, (SELECT COUNT(*)::int FROM videos v WHERE v.channel_id = ch.id) AS video_count
       FROM channels ch LEFT JOIN categories c ON c.id = ch.category_id ORDER BY ch.name`,
    );
    res.json({
      channels: rows.map((c) => ({
        id: c.id,
        url: c.url,
        name: c.name,
        thumbnail: c.thumbnail_url || null,
        category: c.cat_slug,
        trusted: c.trusted,
        videoCount: c.video_count,
        lastSyncedAt: ms(c.last_synced_at),
      })),
    });
  });

  r.post('/channels', async (req, res) => {
    const url = String(req.body.url || '').trim();
    if (!/^https:\/\/(www\.)?youtube\.com\/(@[\w.-]+|channel\/UC[\w-]+)/.test(url)) {
      return res.status(400).json({ error: 'bad_url', message: 'Paste a channel link like https://www.youtube.com/@ChannelName' });
    }
    const clean = url.replace(/\/(videos|featured|shorts|streams)\/?$/, '').replace(/\/$/, '');
    const name = String(req.body.name || '').trim() || clean.split('/').pop();
    const row = await one(
      `INSERT INTO channels (url, name, category_id, trusted) VALUES ($1, $2, $3, $4)
       ON CONFLICT (url) DO UPDATE SET category_id = excluded.category_id, trusted = excluded.trusted RETURNING *`,
      [clean, name, await categoryId(req.body.category), bool(req.body.trusted)],
    );
    let sync = null;
    if (yt.hasApiKey()) sync = await syncChannel(row).catch((err) => ({ error: err.message }));
    res.status(201).json({ id: row.id, sync });
  });

  r.patch('/channels/:id', async (req, res) => {
    const id = idParam(req);
    const c = id && (await one('SELECT * FROM channels WHERE id = $1', [id]));
    if (!c) return res.status(404).json({ error: 'not_found' });
    await query('UPDATE channels SET trusted = $2, category_id = $3 WHERE id = $1', [
      id,
      req.body.trusted !== undefined ? bool(req.body.trusted) : c.trusted,
      req.body.category !== undefined ? await categoryId(req.body.category) : c.category_id,
    ]);
    res.json({ ok: true });
  });

  r.delete('/channels/:id', async (req, res) => {
    const id = idParam(req);
    if (id) await query('DELETE FROM channels WHERE id = $1', [id]);
    res.json({ ok: true });
  });

  r.post('/channels/:id/sync', async (req, res) => {
    const id = idParam(req);
    const c = id && (await one('SELECT * FROM channels WHERE id = $1', [id]));
    if (!c) return res.status(404).json({ error: 'not_found' });
    res.json(await syncChannel(c));
  });

  // ---------- statuses ----------

  r.get('/statuses', async (req, res) => {
    const status = ['published', 'pending', 'rejected'].includes(req.query.status) ? req.query.status : 'pending';
    const rows = await many(
      `SELECT s.*, u.username, u.display_name, u.avatar_media_id, u.verified, m.mime
       FROM statuses s JOIN users u ON u.id = s.user_id LEFT JOIN media m ON m.id = s.media_id
       WHERE s.status = $1 ORDER BY s.created_at DESC LIMIT 100`,
      [status],
    );
    res.json({
      statuses: rows.map((s) => ({
        id: s.id,
        kind: s.kind,
        body: s.body,
        bg: s.bg,
        mediaUrl: mediaUrl(s.media_id),
        mime: s.mime,
        status: s.status,
        createdAt: ms(s.created_at),
        flags: { music: s.has_music, womenSinging: s.women_singing, womenImages: s.women_images, kidSafe: s.kid_safe },
        user: { username: s.username, displayName: s.display_name, avatarUrl: mediaUrl(s.avatar_media_id), verified: s.verified },
      })),
    });
  });

  r.patch('/statuses/:id', async (req, res) => {
    const id = idParam(req);
    const s = id && (await one('SELECT * FROM statuses WHERE id = $1', [id]));
    if (!s) return res.status(404).json({ error: 'not_found' });
    const f = req.body.flags || {};
    await query(
      `UPDATE statuses SET status = $2, has_music = $3, women_singing = $4, women_images = $5, kid_safe = $6 WHERE id = $1`,
      [
        id,
        ['published', 'pending', 'rejected'].includes(req.body.status) ? req.body.status : s.status,
        f.music !== undefined ? bool(f.music) : s.has_music,
        f.womenSinging !== undefined ? bool(f.womenSinging) : s.women_singing,
        f.womenImages !== undefined ? bool(f.womenImages) : s.women_images,
        f.kidSafe !== undefined ? bool(f.kidSafe) : s.kid_safe,
      ],
    );
    if (bool(req.body.verifyCreator)) await query('UPDATE users SET verified = TRUE WHERE id = $1', [s.user_id]);
    res.json({ ok: true });
  });

  r.delete('/statuses/:id', async (req, res) => {
    const id = idParam(req);
    const s = id && (await one('DELETE FROM statuses WHERE id = $1 RETURNING media_id', [id]));
    if (s) await deleteMedia(s.media_id);
    res.json({ ok: true });
  });

  // ---------- users ----------

  r.get('/users', async (req, res) => {
    const params = [];
    let where = 'TRUE';
    if (req.query.q) {
      params.push('%' + String(req.query.q).replace(/[\\%_]/g, '\\$&') + '%');
      where = '(u.username ILIKE $1 OR u.display_name ILIKE $1)';
    }
    const rows = await many(
      `SELECT u.*, (SELECT COUNT(*)::int FROM statuses s WHERE s.user_id = u.id) AS status_count
       FROM users u WHERE ${where} ORDER BY u.created_at DESC LIMIT 200`,
      params,
    );
    res.json({
      users: rows.map((u) => ({
        id: u.id,
        username: u.username,
        displayName: u.display_name,
        avatarUrl: mediaUrl(u.avatar_media_id),
        role: u.role,
        verified: u.verified,
        premium: u.is_premium,
        premiumSource: u.premium_source,
        banned: u.banned,
        creatorStatus: u.creator_status,
        statusCount: u.status_count,
        createdAt: ms(u.created_at),
      })),
    });
  });

  r.patch('/users/:id', async (req, res) => {
    const id = idParam(req);
    const u = id && (await one('SELECT * FROM users WHERE id = $1', [id]));
    if (!u) return res.status(404).json({ error: 'not_found' });
    const b = req.body;
    if (id === req.user.id && ((b.role && b.role !== 'admin') || bool(b.banned))) {
      return res.status(400).json({ error: 'self', message: "You can't remove your own admin access." });
    }
    const premium = b.premium !== undefined ? bool(b.premium) : u.is_premium;
    await query(
      `UPDATE users SET verified = $2, is_premium = $3, premium_source = $4, role = $5, banned = $6 WHERE id = $1`,
      [
        id,
        b.verified !== undefined ? bool(b.verified) : u.verified,
        premium,
        b.premium !== undefined ? (premium ? 'admin' : null) : u.premium_source,
        ['user', 'admin'].includes(b.role) ? b.role : u.role,
        b.banned !== undefined ? bool(b.banned) : u.banned,
      ],
    );
    if (['approved', 'declined', 'none', 'pending'].includes(b.creatorStatus)) {
      await query('UPDATE users SET creator_status = $2 WHERE id = $1', [id, b.creatorStatus]);
    }
    if (bool(b.banned)) await query('DELETE FROM sessions WHERE user_id = $1', [id]);
    res.json({ ok: true });
  });

  // ---------- ads ----------

  const adDto = (a) => ({
    id: a.id,
    title: a.title,
    mediaUrl: mediaUrl(a.media_id),
    mime: a.mime,
    link: a.link_url,
    placement: a.placement,
    active: a.active,
    startsAt: ms(a.starts_at),
    endsAt: ms(a.ends_at),
    weight: a.weight,
    impressions: a.impressions,
    clicks: a.clicks,
  });
  const cleanLink = (s) => {
    const v = String(s || '').trim();
    return v === '' || /^https?:\/\/[^\s]+$/i.test(v) ? v : null;
  };
  const dateOrNull = (s) => {
    const t = Date.parse(s);
    return Number.isFinite(t) ? new Date(t) : null;
  };

  r.get('/ads', async (_req, res) => {
    const rows = await many('SELECT a.*, m.mime FROM ads a LEFT JOIN media m ON m.id = a.media_id ORDER BY a.created_at DESC');
    res.json({ ads: rows.map(adDto) });
  });

  r.post('/ads', single('file'), async (req, res) => {
    const title = String(req.body.title || '').trim().slice(0, 120);
    const link = cleanLink(req.body.link);
    const placement = ['banner', 'watch', 'status'].includes(req.body.placement) ? req.body.placement : 'banner';
    if (!title) return res.status(400).json({ error: 'no_title', message: 'Give the ad a name.' });
    if (link === null) return res.status(400).json({ error: 'bad_link', message: 'The link must start with http:// or https://' });
    if (!req.file) return res.status(400).json({ error: 'no_file', message: 'Choose an image or video for the ad.' });
    const m = await storeMedia(req.file.buffer, req.user.id);
    if (!m || ![...IMAGE_TYPES, ...VIDEO_TYPES].includes(m.mime)) {
      if (m) await deleteMedia(m.id);
      return res.status(400).json({ error: 'bad_type', message: 'Ads must be an image (JPG, PNG, WebP, GIF) or MP4 video.' });
    }
    const row = await one(
      `INSERT INTO ads (title, media_id, link_url, placement, active, starts_at, ends_at, weight)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [
        title,
        m.id,
        link,
        placement,
        req.body.active === undefined ? true : bool(req.body.active),
        dateOrNull(req.body.startsAt),
        dateOrNull(req.body.endsAt),
        Math.min(10, Math.max(1, Number(req.body.weight) || 1)),
      ],
    );
    res.status(201).json({ ad: adDto({ ...row, mime: m.mime }) });
  });

  r.patch('/ads/:id', async (req, res) => {
    const id = idParam(req);
    const a = id && (await one('SELECT * FROM ads WHERE id = $1', [id]));
    if (!a) return res.status(404).json({ error: 'not_found' });
    const b = req.body;
    const link = b.link !== undefined ? cleanLink(b.link) : a.link_url;
    if (link === null) return res.status(400).json({ error: 'bad_link', message: 'The link must start with http:// or https://' });
    await query(
      `UPDATE ads SET title = $2, link_url = $3, placement = $4, active = $5, starts_at = $6, ends_at = $7, weight = $8 WHERE id = $1`,
      [
        id,
        b.title !== undefined ? String(b.title).trim().slice(0, 120) || a.title : a.title,
        link,
        ['banner', 'watch', 'status'].includes(b.placement) ? b.placement : a.placement,
        b.active !== undefined ? bool(b.active) : a.active,
        b.startsAt !== undefined ? dateOrNull(b.startsAt) : a.starts_at,
        b.endsAt !== undefined ? dateOrNull(b.endsAt) : a.ends_at,
        b.weight !== undefined ? Math.min(10, Math.max(1, Number(b.weight) || 1)) : a.weight,
      ],
    );
    res.json({ ok: true });
  });

  r.delete('/ads/:id', async (req, res) => {
    const id = idParam(req);
    const a = id && (await one('DELETE FROM ads WHERE id = $1 RETURNING media_id', [id]));
    if (a) await deleteMedia(a.media_id);
    res.json({ ok: true });
  });

  // ---------- reports ----------

  r.get('/reports', async (_req, res) => {
    const rows = await many(
      `SELECT r.*, u.username AS reporter,
         CASE WHEN r.target_type = 'video' THEN (SELECT title FROM videos WHERE id = r.target_id)
              ELSE (SELECT COALESCE(NULLIF(s.body, ''), s.kind) || ' (by @' || su.username || ')'
                    FROM statuses s JOIN users su ON su.id = s.user_id WHERE s.id = r.target_id) END AS target_label
       FROM reports r LEFT JOIN users u ON u.id = r.user_id
       WHERE NOT r.resolved ORDER BY r.created_at DESC LIMIT 200`,
    );
    res.json({
      reports: rows.map((x) => ({
        id: x.id,
        type: x.target_type,
        targetId: x.target_id,
        targetLabel: x.target_label || '(removed)',
        reason: x.reason,
        reporter: x.reporter,
        createdAt: ms(x.created_at),
      })),
    });
  });

  r.patch('/reports/:id', async (req, res) => {
    const id = idParam(req);
    if (id) await query('UPDATE reports SET resolved = TRUE WHERE id = $1', [id]);
    res.json({ ok: true });
  });

  // ---------- categories & settings ----------

  r.post('/categories', async (req, res) => {
    const nameEn = String(req.body.nameEn || '').trim().slice(0, 40);
    const nameYi = String(req.body.nameYi || '').trim().slice(0, 40) || nameEn;
    const slug = nameEn.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    if (!slug) return res.status(400).json({ error: 'bad_name', message: 'Give the category an English name.' });
    await query(
      `INSERT INTO categories (slug, name_en, name_yi, sort) VALUES ($1, $2, $3, (SELECT COALESCE(MAX(sort), 0) + 1 FROM categories))
       ON CONFLICT (slug) DO UPDATE SET name_en = excluded.name_en, name_yi = excluded.name_yi`,
      [slug, nameEn, nameYi],
    );
    res.status(201).json({ slug });
  });

  r.get('/settings', async (_req, res) => {
    res.json({ settings: await getSettings(), cities: CITIES });
  });

  r.patch('/settings', async (req, res) => {
    const b = req.body;
    const cur = await getSettings();
    await tx(async () => {
      if (b.siteName !== undefined) await setSetting('siteName', String(b.siteName).trim().slice(0, 40) || cur.siteName);
      if (b.premiumPrice !== undefined) await setSetting('premiumPrice', String(b.premiumPrice).trim().slice(0, 40));
      if (b.announcement !== undefined) await setSetting('announcement', String(b.announcement).trim().slice(0, 240));
      if (b.musicPeriods !== undefined) await setSetting('musicPeriods', bool(b.musicPeriods));
      if (b.shabbos !== undefined) {
        await setSetting('shabbos', {
          enabled: bool(b.shabbos.enabled),
          city: CITIES.includes(b.shabbos.city) ? b.shabbos.city : cur.shabbos.city,
        });
      }
    });
    const { invalidateSettings } = await import('./app.js');
    invalidateSettings();
    res.json({ settings: await getSettings() });
  });

  return r;
}
