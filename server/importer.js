// Admin "import from a link": copies a video a creator shared with you (Google Drive,
// Dropbox, OneDrive or a direct link) onto Lichtig. Runs in the background.
//
// Lichtig never copies from YouTube or other video platforms. Those links are refused.

import fs from 'fs';
import os from 'os';
import path from 'path';
import net from 'net';
import dns from 'dns/promises';
import crypto from 'crypto';
import { Readable, Transform } from 'stream';
import { pipeline } from 'stream/promises';
import { query, one } from './db.js';
import { storeFile, maxVideoBytes } from './media.js';

const VIDEO_SITES =
  /(^|\.)(youtube\.com|youtu\.be|youtube-nocookie\.com|googlevideo\.com|ytimg\.com|vimeo\.com|vimeocdn\.com|tiktok\.com|instagram\.com|facebook\.com|fb\.watch|fbcdn\.net|twitter\.com|x\.com|twimg\.com|dailymotion\.com|rumble\.com|twitch\.tv|bitchute\.com|odysee\.com)$/i;

const fail = (message) => Object.assign(new Error(message), { status: 400 });
const NOT_FROM_VIDEO_SITES =
  "Lichtig doesn't copy videos from YouTube or other video sites. Ask the creator to send you the original file (Google Drive, Dropbox, OneDrive or a direct link).";

/** Turn a share link into a direct download link. Throws a friendly error for bad links. */
export function normalizeLink(input) {
  let url;
  try {
    url = new URL(String(input || '').trim());
  } catch {
    throw fail('That doesn’t look like a link.');
  }
  if (!/^https?:$/.test(url.protocol)) throw fail('Links must start with http:// or https://');
  const host = url.hostname.toLowerCase();
  if (VIDEO_SITES.test(host)) throw fail(NOT_FROM_VIDEO_SITES);

  if (host === 'drive.google.com' || host === 'docs.google.com') {
    const m = url.pathname.match(/\/file\/d\/([\w-]{10,})/);
    const id = m ? m[1] : url.searchParams.get('id');
    if (!id) throw fail('Use a Google Drive “Share” link to a single video file.');
    return { url: `https://drive.usercontent.google.com/download?id=${encodeURIComponent(id)}&export=download&confirm=t`, kind: 'Google Drive' };
  }
  if (host === 'dropbox.com' || host.endsWith('.dropbox.com')) {
    url.searchParams.set('dl', '1');
    return { url: url.toString(), kind: 'Dropbox' };
  }
  if (host === '1drv.ms' || host.endsWith('onedrive.live.com') || host.endsWith('sharepoint.com')) {
    url.searchParams.set('download', '1');
    return { url: url.toString(), kind: 'OneDrive' };
  }
  return { url: url.toString(), kind: 'Link' };
}

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const l = ip.toLowerCase();
  if (l.startsWith('::ffff:')) return isPrivateIp(l.slice(7));
  return l === '::1' || l === '::' || l.startsWith('fc') || l.startsWith('fd') || l.startsWith('fe80');
}

async function assertPublicHost(hostname) {
  if (process.env.ALLOW_PRIVATE_IMPORTS === 'true') return; // tests only
  const addrs = await dns.lookup(hostname, { all: true });
  if (!addrs.length || addrs.some((a) => isPrivateIp(a.address))) throw fail('That link points to a private address.');
}

/** Fetch with redirects followed by hand, so every hop is checked. */
async function fetchChecked(url, hops = 0) {
  if (hops > 6) throw fail('That link redirects too many times.');
  const u = new URL(url);
  if (!/^https?:$/.test(u.protocol)) throw fail('That link redirects somewhere unsupported.');
  if (VIDEO_SITES.test(u.hostname)) throw fail(NOT_FROM_VIDEO_SITES);
  await assertPublicHost(u.hostname);
  const res = await fetch(u, { redirect: 'manual', headers: { 'User-Agent': 'LichtigImporter/1.0' }, signal: AbortSignal.timeout(2 * 3600 * 1000) });
  if ([301, 302, 303, 307, 308].includes(res.status)) {
    const loc = res.headers.get('location');
    if (!loc) throw fail('That link redirects nowhere.');
    return fetchChecked(new URL(loc, u).toString(), hops + 1);
  }
  if (!res.ok) throw fail(`The link answered with an error (${res.status}). Check that it’s shared with “Anyone with the link”.`);
  return res;
}

/** Create the video (status "processing") and copy the file in the background. */
export async function startImport({ link, title, description = '', categoryId = null, flags, rightsNote, creatorId = null, channelName, addedBy, publish }) {
  const { url } = normalizeLink(link);
  const row = await one(
    `INSERT INTO videos (source, title, description, channel_name, category_id, kid_safe, has_music, women_singing, women_images,
       is_news, status, added_by, creator_id, rights_note, source_url)
     VALUES ('upload', $1, $2, $3, $4, $5, $6, $7, $8, $9, 'processing', $10, $11, $12, $13) RETURNING id`,
    [title, description, channelName, categoryId, flags.kid_safe, flags.has_music, flags.women_singing, flags.women_images, flags.is_news, addedBy, creatorId, rightsNote, String(link).slice(0, 500)],
  );
  runImport(row.id, url, { publish, ownerId: addedBy }).catch((err) => console.error('Import crashed:', err));
  return { id: row.id };
}

export async function runImport(videoId, url, { publish, ownerId }) {
  const tmp = path.join(os.tmpdir(), `lichtig-import-${crypto.randomUUID()}`);
  const limit = maxVideoBytes();
  try {
    const res = await fetchChecked(url);
    const len = Number(res.headers.get('content-length') || 0);
    if (len > limit) throw fail(`That file is too big (limit ${Math.round(limit / 1048576)} MB).`);
    if (/text\/html/i.test(res.headers.get('content-type') || '')) {
      throw fail('That link opens a web page, not a video file. Make sure sharing is set to “Anyone with the link”.');
    }
    let bytes = 0;
    const guard = new Transform({
      transform(chunk, _enc, cb) {
        bytes += chunk.length;
        if (bytes > limit) cb(fail(`That file is too big (limit ${Math.round(limit / 1048576)} MB).`));
        else cb(null, chunk);
      },
    });
    await pipeline(Readable.fromWeb(res.body), guard, fs.createWriteStream(tmp));
    const media = await storeFile(tmp, ownerId);
    await query(
      `UPDATE videos SET media_id = $2, status = $3, import_error = '',
         published_at = CASE WHEN $3 = 'published' THEN now() ELSE NULL END WHERE id = $1`,
      [videoId, media.id, publish ? 'published' : 'pending'],
    );
  } catch (err) {
    await query(`UPDATE videos SET status = 'failed', import_error = $2 WHERE id = $1`, [videoId, String(err.message || err).slice(0, 300)]);
  } finally {
    fs.rm(tmp, { force: true }, () => {});
  }
}

/** Imports cut off by a restart can't resume; mark them so the admin can retry. */
export async function failInterruptedImports() {
  await query(`UPDATE videos SET status = 'failed', import_error = 'The import was interrupted by a restart. Please try again.' WHERE status = 'processing'`);
}
