// Parental controls. Settings live on the account, and are also pinned to the device
// with a signed cookie so signing out does not remove the restrictions.

import crypto from 'crypto';
import { musicPeriod } from './jewish.js';

const SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const LOCK_COOKIE = 'lt_lock';
const YEAR_MS = 365 * 24 * 60 * 60 * 1000;

export const FILTER_KEYS = [
  'kidsMode',
  'hideMusic',
  'autoMusicPeriods',
  'hideWomenSinging',
  'hideWomenImages',
  'hideNews',
  'hideStatuses',
];

export function sanitizeFilters(input = {}) {
  const out = {};
  for (const k of FILTER_KEYS) out[k] = !!input[k];
  const limit = Math.round(Number(input.dailyLimitMin) || 0);
  out.dailyLimitMin = Math.min(600, Math.max(0, limit));
  return out;
}

export function publicParental(p) {
  if (!p || !p.enabled) return { enabled: false, ...sanitizeFilters({}) };
  return { enabled: true, ...sanitizeFilters(p) };
}

const sign = (data) => crypto.createHmac('sha256', SECRET).update(data).digest('base64url');

export function readLock(req) {
  const raw = req.cookies?.[LOCK_COOKIE];
  if (!raw || !raw.includes('.')) return null;
  const [data, mac] = raw.split('.');
  const expected = sign(data);
  if (mac.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return null;
  try {
    return JSON.parse(Buffer.from(data, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

export function writeLock(res, parental, secure) {
  const data = Buffer.from(JSON.stringify({ filters: sanitizeFilters(parental), pinHash: parental.pinHash })).toString(
    'base64url',
  );
  res.cookie(LOCK_COOKIE, `${data}.${sign(data)}`, { httpOnly: true, sameSite: 'lax', secure, maxAge: YEAR_MS, path: '/' });
}

export function clearLock(res) {
  res.clearCookie(LOCK_COOKIE, { path: '/' });
}

/** Combine account and device restrictions: anything either one hides stays hidden. */
export function effectiveFilters(req, settings) {
  const account = req.user?.parental?.enabled ? req.user.parental : null;
  const device = readLock(req);
  const f = { locked: !!(account || device) };
  for (const k of FILTER_KEYS) f[k] = !!(account?.[k] || device?.filters?.[k]);
  const limits = [account?.dailyLimitMin, device?.filters?.dailyLimitMin].filter((n) => n > 0);
  f.dailyLimitMin = limits.length ? Math.min(...limits) : 0;
  const period = musicPeriod();
  f.musicPeriod = period;
  f.musicBlocked = f.hideMusic || (!!period && (f.autoMusicPeriods || !!settings.musicPeriods));
  return f;
}

/** SQL conditions (no user input) for videos under these filters. */
export function videoConditions(f, a = 'v') {
  const c = [`${a}.status = 'published'`];
  if (f.kidsMode) c.push(`${a}.kid_safe`);
  if (f.musicBlocked) c.push(`NOT ${a}.has_music`);
  if (f.hideWomenSinging) c.push(`NOT ${a}.women_singing`);
  if (f.hideWomenImages) c.push(`NOT ${a}.women_images`);
  if (f.hideNews) c.push(`NOT ${a}.is_news`);
  return c;
}

export function statusConditions(f, a = 's') {
  const c = [`${a}.status = 'published'`];
  if (f.hideStatuses) c.push('FALSE');
  if (f.kidsMode) c.push(`${a}.kid_safe`);
  if (f.musicBlocked) c.push(`NOT ${a}.has_music`);
  if (f.hideWomenSinging) c.push(`NOT ${a}.women_singing`);
  if (f.hideWomenImages) c.push(`NOT ${a}.women_images`);
  return c;
}
