// Uploaded files (status photos/videos, avatars, ads, hosted videos) are stored in the
// database so they survive restarts on hosts without a persistent disk.

import { one, query, toBuffer } from './db.js';

export const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
export const VIDEO_TYPES = ['video/mp4', 'video/webm', 'video/quicktime'];

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

export async function storeMedia(buf, ownerId) {
  const mime = sniff(buf);
  if (!mime) return null;
  const row = await one('INSERT INTO media (owner_id, mime, size, data) VALUES ($1, $2, $3, $4) RETURNING id, mime', [
    ownerId || null,
    mime,
    buf.length,
    buf,
  ]);
  return row;
}

export const mediaUrl = (id) => (id ? `/media/${id}` : null);

export async function deleteMedia(id) {
  if (id) await query('DELETE FROM media WHERE id = $1', [id]);
}

const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov' };

/** Stream a stored file, with HTTP range support so videos can seek. */
export async function serveMedia(req, res, { allowDownload }) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(404).end();
  const meta = await one('SELECT mime, size, created_at FROM media WHERE id = $1', [id]);
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
  if (range && meta.size > 0) {
    let start = range[1] === '' ? meta.size - Number(range[2]) : Number(range[1]);
    let end = range[1] === '' || range[2] === '' ? meta.size - 1 : Number(range[2]);
    end = Math.min(end, meta.size - 1, start + 2 * 1024 * 1024 - 1); // at most 2 MB per chunk
    start = Math.max(0, start);
    if (start > end || start >= meta.size) {
      res.setHeader('Content-Range', `bytes */${meta.size}`);
      return res.status(416).end();
    }
    const row = await one('SELECT substring(data FROM $2 FOR $3) AS chunk FROM media WHERE id = $1', [
      id,
      start + 1,
      end - start + 1,
    ]);
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
