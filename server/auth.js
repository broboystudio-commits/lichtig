import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { one, query } from './db.js';

const COOKIE = 'lt_session';
const SESSION_MS = 30 * 24 * 60 * 60 * 1000;
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

export const hashPassword = (pw) => bcrypt.hashSync(pw, 10);
export const checkPassword = (pw, hash) => bcrypt.compareSync(pw, hash);

export async function createSession(res, userId, secure) {
  const token = crypto.randomBytes(32).toString('base64url');
  await query('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, $3)', [
    sha256(token),
    userId,
    new Date(Date.now() + SESSION_MS),
  ]);
  res.cookie(COOKIE, token, { httpOnly: true, sameSite: 'lax', secure, maxAge: SESSION_MS, path: '/' });
}

export async function destroySession(req, res) {
  const token = req.cookies?.[COOKIE];
  if (token) await query('DELETE FROM sessions WHERE token_hash = $1', [sha256(token)]);
  res.clearCookie(COOKIE, { path: '/' });
}

export async function loadUser(req, _res, next) {
  try {
    const token = req.cookies?.[COOKIE];
    req.user = token
      ? await one(
          `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
           WHERE s.token_hash = $1 AND s.expires_at > now() AND NOT u.banned`,
          [sha256(token)],
        )
      : null;
    next();
  } catch (err) {
    next(err);
  }
}

export function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'auth_required', message: 'Please sign in first.' });
  next();
}

export function requireAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'auth_required', message: 'Please sign in first.' });
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'forbidden', message: 'Admins only.' });
  next();
}

export const pruneSessions = () => query('DELETE FROM sessions WHERE expires_at <= now()');
