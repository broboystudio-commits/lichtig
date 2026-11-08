// Uploaded files (shorts, hosted videos, thumbnails, avatars, ads).
// With object storage configured (Cloudflare R2 / S3) files live there; otherwise they're
// kept in the database. Either way viewers fetch them from Lichtig's own /media/:id URL.

import crypto from 'crypto';
import fs from 'fs';
import { Readable } from 'stream';
import { one, query, toBuffer } from './db.js';
import * as storage from './storage.js';

export const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
export const VIDEO_TYPES = ['video/mp4', 'video/webm', 'video/quicktime'];
export const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov' };

// Largest video kept in the database when no object storage is connected.
export const DB_VIDEO_MAX_MB = Number(process.env.DB_VIDEO_MAX_MB) || 60;

export function sniff(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.toString('hex', 0, 4) === '89504e47') return 'image/png';
  if (buf.toString('latin1', 0, 4) === 'GIF8') return 'image/gif';
  if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return 'video/webm';
  const box = buf.toString('latin1', 4, 8);
  if (box === 'ftyp') return buf.toString('latin1', 8, 10) === 'qt' ? 'video/quicktime' : 'video/mp4';
  if (['moov', 'mdat', 'wide', 'free', 'skip'].includes(box)) return 'video/quicktime';
  return null;
}

export const newObjectKey = (mime) =>
  `${mime.startsWith('video/') ? 'videos' : 'images'}/${new Date().toISOString().slice(0, 7)}/${crypto.randomUUID()}.${EXT[mime] || 'bin'}`;

/** Store a small file held in memory (up to MAX_UPLOAD_MB). */
export async function storeMedia(buf, ownerId) {
  const mime = sniff(buf);
  if (!mime) return null;
  if (storage.storageEnabled()) {
    const key = newObjectKey(mime);
    await storage.putBuffer(key, buf, mime);
    return one(`INSERT INTO media (owner_id, mime, size, storage, object_key) VALUES ($1, $2, $3, 's3', $4) RETURNING id, mime`, [
      ownerId || null,
      mime,
      buf.length,
      key,
    ]);
  }
  return one('INSERT INTO media (owner_id, mime, size, data) VALUES ($1, $2, $3, $4) RETURNING id, mime', [ownerId || null, mime, buf.length, buf]);
}

/** Store a (possibly very large) file from disk. Throws a friendly error if it can't be kept. */
export async function storeFile(filePath, ownerId) {
  const size = fs.statSync(filePath).size;
  const head = Buffer.alloc(16);
  const fd = fs.openSync(filePath, 'r');
  fs.readSync(fd, head, 0, 16, 0);
  fs.closeSync(fd);
  const mime = sniff(head);
  if (!mime || !VIDEO_TYPES.includes(mime)) {
    throw Object.assign(new Error("That link didn't give a video file. Make sure sharing is set to “Anyone with the link”."), { status: 400 });
  }
  if (storage.storageEnabled()) {
    const key = newObjectKey(mime);
    await storage.putFile(key, filePath, mime, size);
    return one(`INSERT INTO media (owner_id, mime, size, storage, object_key) VALUES ($1, $2, $3, 's3', $4) RETURNING id, mime`, [
      ownerId || null,
      mime,
      size,
      key,
    ]);
  }
  if (size > DB_VIDEO_MAX_MB * 1024 * 1024) {
    throw Object.assign(new Error(`Videos over ${DB_VIDEO_MAX_MB} MB need video storage (Cloudflare R2) to be connected first.`), { status: 400 });
  }
  const buf = fs.readFileSync(filePath);
  return one('INSERT INTO media (owner_id, mime, size, data) VALUES ($1, $2, $3, $4) RETURNING id, mime', [ownerId || null, mime, size, buf]);
}

// Largest single video upload (with object storage); without it, DB_VIDEO_MAX_MB applies.
export const VIDEO_MAX_MB = Number(process.env.VIDEO_MAX_MB) || 4096;
export const maxVideoBytes = () => (storage.storageEnabled() ? VIDEO_MAX_MB : DB_VIDEO_MAX_MB) * 1024 * 1024;

/** Reserve a slot for a video upload. The browser then PUTs the file to Lichtig itself. */
export async function reserveUpload({ mime, size, ownerId }) {
  const s3 = storage.storageEnabled();
  const row = await one(
    `INSERT INTO media (owner_id, mime, size, storage, object_key) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [ownerId, mime, size, s3 ? 's3' : 'db', s3 ? newObjectKey(mime) : null],
  );
  return { mediaId: row.id, uploadUrl: `/api/creator/uploads/${row.id}` };
}

/** Receive the uploaded bytes (streamed straight to storage, or into the database). */
export async function receiveUpload(mediaId, ownerId, req) {
  const m = await one('SELECT * FROM media WHERE id = $1 AND owner_id = $2', [mediaId, ownerId]);
  if (!m) throw Object.assign(new Error('Upload not found.'), { status: 404 });
  const length = Number(req.headers['content-length']);
  if (!length || length !== m.size) throw Object.assign(new Error('The file size does not match.'), { status: 400 });
  if (m.storage === 's3') {
    await storage.putStream(m.object_key, req, m.mime, length);
    return;
  }
  const chunks = [];
  let got = 0;
  for await (const c of req) {
    got += c.length;
    if (got > length) throw Object.assign(new Error('The file is larger than expected.'), { status: 400 });
    chunks.push(c);
  }
  await query('UPDATE media SET data = $2 WHERE id = $1', [m.id, Buffer.concat(chunks)]);
}

/** Confirm an upload actually arrived and really is a video. */
export async function confirmUpload(mediaId, ownerId) {
  const m = await one('SELECT id, storage, object_key, size FROM media WHERE id = $1 AND owner_id = $2', [mediaId, ownerId]);
  if (!m) return null;
  let head;
  let size = m.size;
  if (m.storage === 's3') {
    const h = await storage.headObject(m.object_key);
    if (!h) return null;
    size = h.size;
    head = await storage.readHead(m.object_key, 16);
  } else {
    const r = await one('SELECT substring(data FROM 1 FOR 16) AS head, length(data) AS n FROM media WHERE id = $1', [m.id]);
    if (!r || !r.n) return null;
    head = toBuffer(r.head);
    size = Number(r.n);
  }
  const mime = sniff(head);
  if (!mime || !VIDEO_TYPES.includes(mime)) {
    await deleteMedia(m.id);
    throw Object.assign(new Error('That file is not a supported video (MP4, WebM or MOV).'), { status: 400 });
  }
  await query('UPDATE media SET size = $2, mime = $3 WHERE id = $1', [m.id, size, mime]);
  return { id: m.id, mime, size };
}

export const mediaUrl = (id) => (id ? `/media/${id}` : null);

export async function deleteMedia(id) {
  if (!id) return;
  const m = await one('DELETE FROM media WHERE id = $1 RETURNING storage, object_key', [id]);
  if (m && m.storage === 's3' && m.object_key && storage.storageEnabled()) {
    await storage.deleteObject(m.object_key).catch((err) => console.warn('Could not delete stored file:', err.message));
  }
}

/** Remove browser uploads that were started but never attached to anything. */
export async function cleanupOrphans() {
  const rows = await query(
    `SELECT id FROM media m WHERE m.created_at < now() - interval '1 day' AND (m.storage = 's3' OR m.data IS NULL)
       AND NOT EXISTS (SELECT 1 FROM videos v WHERE v.media_id = m.id OR v.poster_media_id = m.id)
       AND NOT EXISTS (SELECT 1 FROM statuses s WHERE s.media_id = m.id)
       AND NOT EXISTS (SELECT 1 FROM ads a WHERE a.media_id = m.id)
       AND NOT EXISTS (SELECT 1 FROM users u WHERE u.avatar_media_id = m.id)`,
  );
  for (const r of rows.rows) await deleteMedia(r.id);
}

/** Stream a stored file, with HTTP range support so videos can seek. */
export async function serveMedia(req, res, { allowDownload }) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(404).end();
  const meta = await one('SELECT mime, size, storage, object_key FROM media WHERE id = $1', [id]);
  if (!meta) return res.status(404).end();

  const download = req.query.download === '1';
  if (download && !allowDownload) {
    return res.status(402).json({ error: 'premium_required', message: 'Downloading is a Premium feature.' });
  }

  const etag = `"m${id}-${meta.size}"`;
  res.setHeader('ETag', etag);
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Type', meta.mime);
  res.setHeader('Cache-Control', download ? 'private, no-store' : 'public, max-age=86400');
  if (download) res.setHeader('Content-Disposition', `attachment; filename="lichtig-${id}.${EXT[meta.mime] || 'bin'}"`);
  if (!download && req.headers['if-none-match'] === etag) return res.status(304).end();

  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');

  if (meta.storage === 's3') {
    const upstream = await storage.getObject(meta.object_key, range ? req.headers.range : undefined);
    res.status(upstream.status === 206 ? 206 : 200);
    for (const h of ['content-range', 'content-length']) {
      const v = upstream.headers.get(h);
      if (v) res.setHeader(h, v);
    }
    const body = Readable.fromWeb(upstream.body);
    res.on('close', () => body.destroy());
    body.on('error', () => res.destroy());
    return body.pipe(res);
  }

  if (range && meta.size > 0) {
    let start = range[1] === '' ? meta.size - Number(range[2]) : Number(range[1]);
    let end = range[1] === '' || range[2] === '' ? meta.size - 1 : Number(range[2]);
    end = Math.min(end, meta.size - 1, start + 2 * 1024 * 1024 - 1); // at most 2 MB per chunk
    start = Math.max(0, start);
    if (start > end || start >= meta.size) {
      res.setHeader('Content-Range', `bytes */${meta.size}`);
      return res.status(416).end();
    }
    const row = await one('SELECT substring(data FROM $2 FOR $3) AS chunk FROM media WHERE id = $1', [id, start + 1, end - start + 1]);
    const chunk = toBuffer(row.chunk);
    res.status(206);
    res.setHeader('Content-Range', `bytes ${start}-${start + chunk.length - 1}/${meta.size}`);
    res.setHeader('Content-Length', chunk.length);
    return res.end(chunk);
  }
  const row = await one('SELECT data FROM media WHERE id = $1', [id]);
  const data = toBuffer(row.data);
  res.setHeader('Content-Length', data.length);
  res.end(data);
}
