// Creator accounts: users apply, the admin approves, and approved creators upload
// full-length videos (with a rights confirmation). Every creator upload is reviewed by
// the admin before it goes live. Admins use the same upload flow for originals.

import express from 'express';
import { one, many, query, ms } from './db.js';
import { requireAuth } from './auth.js';
import { VIDEO_TYPES, IMAGE_TYPES, reserveUpload, receiveUpload, confirmUpload, storeMedia, deleteMedia, mediaUrl, maxVideoBytes } from './media.js';
import { flagsFrom } from './admin.js';

const EXT_TYPES = { mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime' };
const bool = (v) => v === true || v === 'true' || v === '1' || v === 'on' || v === 1;

const isCreator = (u) => !!u && (u.creator_status === 'approved' || u.role === 'admin');

function requireCreator(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'auth_required', message: 'Please sign in first.' });
  if (!isCreator(req.user)) return res.status(403).json({ error: 'not_creator', message: 'Only approved creators can upload videos.' });
  next();
}

export const myVideoDto = (r) => ({
  id: r.id,
  title: r.title,
  status: r.status,
  importError: r.import_error || null,
  thumbnail: r.thumbnail_url || mediaUrl(r.poster_media_id),
  mediaUrl: mediaUrl(r.media_id),
  views: r.views,
  createdAt: ms(r.created_at),
});

export function creatorRouter({ uploadPoster, writeLimiter }) {
  const r = express.Router();

  r.post('/apply', requireAuth, async (req, res) => {
    if (isCreator(req.user)) return res.status(400).json({ error: 'already', message: 'You can already upload videos.' });
    const channel = String(req.body.channel || '').trim().slice(0, 80);
    const about = String(req.body.about || '').trim().slice(0, 600);
    const contact = String(req.body.contact || '').trim().slice(0, 120);
    if (!channel || !about) return res.status(400).json({ error: 'missing', message: 'Tell us your channel name and what you post.' });
    await query(`UPDATE users SET creator_status = 'pending', creator_note = $2 WHERE id = $1`, [
      req.user.id,
      JSON.stringify({ channel, about, contact, at: Date.now() }),
    ]);
    res.json({ creatorStatus: 'pending' });
  });

  // 1. Reserve a slot. 2. PUT the file to the returned URL (on Lichtig). 3. Create the video.
  r.post('/uploads', requireCreator, writeLimiter, async (req, res) => {
    const ext = String(req.body.filename || '').split('.').pop().toLowerCase();
    const mime = VIDEO_TYPES.includes(req.body.mime) ? req.body.mime : EXT_TYPES[ext];
    const size = Math.round(Number(req.body.size));
    if (!mime) return res.status(400).json({ error: 'bad_type', message: 'Please choose an MP4, WebM or MOV video.' });
    if (!size || size <= 0) return res.status(400).json({ error: 'bad_size', message: 'That file looks empty.' });
    if (size > maxVideoBytes()) {
      return res.status(413).json({ error: 'too_large', message: `Videos can be up to ${Math.round(maxVideoBytes() / 1048576)} MB.` });
    }
    res.status(201).json(await reserveUpload({ mime, size, ownerId: req.user.id }));
  });

  r.put('/uploads/:id', requireCreator, async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(404).json({ error: 'not_found' });
    await receiveUpload(id, req.user.id, req);
    res.json({ ok: true });
  });

  r.post('/videos', requireCreator, writeLimiter, uploadPoster, async (req, res) => {
    const b = req.body;
    const title = String(b.title || '').trim().slice(0, 200);
    if (!title) return res.status(400).json({ error: 'no_title', message: 'Give the video a title.' });
    if (!bool(b.rights)) {
      return res.status(400).json({ error: 'rights', message: 'Please confirm you own this video or have permission to publish it.' });
    }
    const media = await confirmUpload(Number(b.mediaId), req.user.id);
    if (!media) return res.status(400).json({ error: 'no_upload', message: 'The video upload did not finish. Please upload it again.' });

    let posterId = null;
    if (req.file) {
      const p = await storeMedia(req.file.buffer, req.user.id);
      if (p && IMAGE_TYPES.includes(p.mime)) posterId = p.id;
      else if (p) await deleteMedia(p.id);
    }
    const cat = b.category ? await one('SELECT id FROM categories WHERE slug = $1', [String(b.category)]) : null;
    const f = flagsFrom(b);
    const isAdmin = req.user.role === 'admin';
    const status = isAdmin && b.publish !== 'false' && b.publish !== false ? 'published' : 'pending';
    const rightsNote = `Confirmed by @${req.user.username} on ${new Date().toISOString().slice(0, 10)}${b.rightsNote ? ': ' + String(b.rightsNote).trim().slice(0, 300) : ''}`;
    const row = await one(
      `INSERT INTO videos (source, media_id, poster_media_id, title, description, channel_name, category_id, kid_safe, has_music,
         women_singing, women_images, is_news, status, added_by, creator_id, rights_note, published_at)
       VALUES ('upload', $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $13, $14,
         CASE WHEN $12 = 'published' THEN now() ELSE NULL END) RETURNING id`,
      [
        media.id,
        posterId,
        title,
        String(b.description || '').slice(0, 5000),
        isAdmin && b.channelName ? String(b.channelName).slice(0, 80) : req.user.display_name,
        cat ? cat.id : null,
        f.kid_safe,
        f.has_music,
        f.women_singing,
        f.women_images,
        f.is_news,
        status,
        req.user.id,
        rightsNote,
      ],
    );
    res.status(201).json({ id: row.id, pending: status !== 'published' });
  });

  r.get('/videos', requireCreator, async (req, res) => {
    const rows = await many(`SELECT * FROM videos WHERE creator_id = $1 ORDER BY created_at DESC LIMIT 200`, [req.user.id]);
    res.json({ videos: rows.map(myVideoDto) });
  });

  r.delete('/videos/:id', requireCreator, async (req, res) => {
    const id = Number(req.params.id);
    const v = await one('SELECT * FROM videos WHERE id = $1 AND creator_id = $2', [id, req.user.id]);
    if (!v) return res.status(404).json({ error: 'not_found', message: 'Video not found.' });
    await query('DELETE FROM videos WHERE id = $1', [id]);
    await deleteMedia(v.media_id);
    await deleteMedia(v.poster_media_id);
    res.json({ ok: true });
  });

  return r;
}
