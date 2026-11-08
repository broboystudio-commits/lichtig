// Object storage for video files: Cloudflare R2 or any S3-compatible service.
// Configure with S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY (and
// optionally S3_REGION, default "auto"). Without these, files stay in the database.
//
// Files are always streamed to viewers through Lichtig's own address (/media/:id), so a
// filter that allows Lichtig also allows its videos.

import fs from 'fs';
import http from 'http';
import https from 'https';
import { AwsClient } from 'aws4fetch';

const cfg = () => ({
  endpoint: (process.env.S3_ENDPOINT || '').replace(/\/+$/, ''),
  bucket: process.env.S3_BUCKET || '',
  accessKeyId: process.env.S3_ACCESS_KEY_ID || '',
  secretAccessKey: process.env.S3_SECRET_ACCESS_KEY || '',
  region: process.env.S3_REGION || 'auto',
});

export function storageEnabled() {
  const c = cfg();
  return !!(c.endpoint && c.bucket && c.accessKeyId && c.secretAccessKey);
}

let client = null;
function aws() {
  const c = cfg();
  if (!client) client = new AwsClient({ accessKeyId: c.accessKeyId, secretAccessKey: c.secretAccessKey, service: 's3', region: c.region });
  return client;
}

const objectUrl = (key) => {
  const c = cfg();
  return `${c.endpoint}/${c.bucket}/${key.split('/').map(encodeURIComponent).join('/')}`;
};

async function check(res, what) {
  if (res.ok || res.status === 206) return res;
  const text = await res.text().catch(() => '');
  const err = new Error(`Storage ${what} failed (${res.status}) ${text.slice(0, 200)}`);
  err.status = 502;
  throw err;
}

/** Upload a Buffer. */
export async function putBuffer(key, buf, mime) {
  const res = await aws().fetch(objectUrl(key), {
    method: 'PUT',
    body: buf,
    headers: { 'Content-Type': mime, 'Content-Length': String(buf.length) },
  });
  await check(res, 'upload');
}

/** Stream an upload of known length to storage (never buffers the whole file). */
export async function putStream(key, stream, mime, size) {
  const url = new URL(await presignPut(key, mime, 6 * 3600));
  const lib = url.protocol === 'http:' ? http : https;
  await new Promise((resolve, reject) => {
    const req = lib.request(url, { method: 'PUT', headers: { 'Content-Type': mime, 'Content-Length': size } }, (res) => {
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () =>
        res.statusCode >= 200 && res.statusCode < 300
          ? resolve()
          : reject(Object.assign(new Error(`Storage upload failed (${res.statusCode}) ${body.slice(0, 200)}`), { status: 502 })),
      );
    });
    req.on('error', reject);
    stream.on('error', (err) => {
      req.destroy(err);
      reject(err);
    });
    stream.pipe(req);
  });
}

/** Upload a file from disk without loading it into memory. */
export const putFile = (key, filePath, mime, size) => putStream(key, fs.createReadStream(filePath), mime, size);

/** A short-lived signed URL for PUTting a file (used by the server). */
export async function presignPut(key, mime, expiresSec = 3600) {
  const url = new URL(objectUrl(key));
  url.searchParams.set('X-Amz-Expires', String(expiresSec));
  // Only the host is signed, so the browser may send its own Content-Type.
  void mime;
  const signed = await aws().sign(new Request(url, { method: 'PUT' }), { aws: { signQuery: true } });
  return signed.url;
}

export async function headObject(key) {
  const res = await aws().fetch(objectUrl(key), { method: 'HEAD' });
  if (res.status === 404) return null;
  await check(res, 'check');
  return { size: Number(res.headers.get('content-length')), type: res.headers.get('content-type') };
}

/** Fetch (part of) an object; returns the raw Response so it can be streamed. */
export async function getObject(key, range) {
  const headers = range ? { Range: range } : {};
  const res = await aws().fetch(objectUrl(key), { method: 'GET', headers });
  return check(res, 'read');
}

export async function readHead(key, bytes = 16) {
  const res = await getObject(key, `bytes=0-${bytes - 1}`);
  return Buffer.from(await res.arrayBuffer());
}

export async function deleteObject(key) {
  const res = await aws().fetch(objectUrl(key), { method: 'DELETE' });
  if (res.status !== 404) await check(res, 'delete');
}
