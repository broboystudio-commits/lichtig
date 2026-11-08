// Shared helpers: DOM building, icons, API calls, translations, toasts and sheets.
import { YI } from './i18n.js';

// ---------------- translations ----------------
export const lang = {
  current: (() => {
    try {
      return localStorage.getItem('lt_lang') === 'yi' ? 'yi' : 'en';
    } catch {
      return 'en';
    }
  })(),
};

export function t(text, vars) {
  let out = lang.current === 'yi' && YI[text] ? YI[text] : text;
  if (vars) for (const [k, v] of Object.entries(vars)) out = out.replaceAll(`{${k}}`, v);
  return out;
}

export function setLang(next) {
  lang.current = next === 'yi' ? 'yi' : 'en';
  try {
    localStorage.setItem('lt_lang', lang.current);
  } catch {
    /* storage unavailable */
  }
  // Only the words change; the layout stays put. Yiddish text still reads right-to-left
  // inside its own element thanks to dir="auto" / Unicode bidi.
  document.documentElement.lang = lang.current === 'yi' ? 'yi' : 'en';
  document.documentElement.dir = 'ltr';
}
setLang(lang.current);

export const catName = (c) => (c ? (lang.current === 'yi' ? c.nameYi || c.name_yi : c.nameEn || c.name_en) : '');

// ---------------- DOM ----------------
export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'style') Object.assign(el.style, value);
    else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2), value);
    else el.setAttribute(key, value === true ? '' : String(value));
  }
  append(el, children);
  return el;
}
export function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}
export function fill(el, ...children) {
  el.replaceChildren();
  return append(el, children);
}

// ---------------- icons (static, trusted markup) ----------------
const P = {
  home: '<path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z"/>',
  status: '<circle cx="12" cy="12" r="9" stroke-dasharray="4 3"/><circle cx="12" cy="12" r="4"/>',
  shorts: '<rect x="6" y="2.5" width="12" height="19" rx="3"/><path d="m10.5 9.5 4 2.5-4 2.5z"/>',
  bookmark: '<path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/>',
  user: '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  crown: '<path d="m3 8 4.5 4L12 5l4.5 7L21 8l-2 11H5z"/>',
  shield: '<path d="M12 3 4 6v6c0 4.5 3.4 8.4 8 9 4.6-.6 8-4.5 8-9V6z"/><path d="m9 12 2 2 4-4"/>',
  heart: '<path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21.2l8.8-8.8a5.5 5.5 0 0 0 0-7.8z"/>',
  share: '<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="m8.6 13.5 6.8 4M15.4 6.5l-6.8 4"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5M12 15V3"/>',
  flag: '<path d="M4 22V4a1 1 0 0 1 1-1h11l-2 4 2 4H5"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  back: '<path d="m15 18-6-6 6-6"/>',
  next: '<path d="m9 18 6-6-6-6"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  play: '<path d="M7 4v16l13-8z" fill="currentColor" stroke="none"/>',
  pause: '<path d="M7 4h3v16H7zM14 4h3v16h-3z" fill="currentColor" stroke="none"/>',
  volume: '<path d="M11 5 6 9H2v6h4l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M19 5a10 10 0 0 1 0 14"/>',
  mute: '<path d="M11 5 6 9H2v6h4l5 4z"/><path d="m23 9-6 6M17 9l6 6"/>',
  image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/>',
  video: '<rect x="2" y="6" width="14" height="12" rx="2"/><path d="m16 10 6-3v10l-6-3z"/>',
  text: '<path d="M4 7V4h16v3M9 20h6M12 4v16"/>',
  calendar: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
  candle: '<path d="M12 2c1.5 2 2 3.2 2 4.2a2 2 0 0 1-4 0C10 5.2 10.5 4 12 2z" fill="currentColor"/><rect x="9" y="10" width="6" height="11" rx="1"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1A1.7 1.7 0 0 0 9 19.4a1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1A1.7 1.7 0 0 0 4.6 9a1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  lock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  trash: '<path d="M3 6h18M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6M10 11v6M14 11v6M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>',
  edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
  grid: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
  megaphone: '<path d="M3 11v2a1 1 0 0 0 1 1h2l5 4V6L6 10H4a1 1 0 0 0-1 1z"/><path d="M15 8a5 5 0 0 1 0 8"/>',
  tv: '<rect x="2" y="7" width="20" height="14" rx="2"/><path d="m17 2-5 5-5-5"/>',
  sparkle: '<path d="M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M18.4 5.6l-2.8 2.8M8.4 15.6l-2.8 2.8"/>',
  users: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8"/>',
  inbox: '<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.5 5.1 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.5-6.9A2 2 0 0 0 16.8 4H7.2a2 2 0 0 0-1.7 1.1z"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/>',
  refresh: '<path d="M21 2v6h-6M3 22v-6h6"/><path d="M3.5 9a9 9 0 0 1 14.8-3.4L21 8M3 16l2.7 2.4A9 9 0 0 0 20.5 15"/>',
  verified: '<path d="M12 2l2.4 2.2 3.2-.4.9 3.1 2.8 1.6-1.2 3 1.2 3-2.8 1.6-.9 3.1-3.2-.4L12 22l-2.4-2.2-3.2.4-.9-3.1-2.8-1.6 1.2-3-1.2-3 2.8-1.6.9-3.1 3.2.4z" fill="currentColor" stroke="none"/><path d="m8.5 12 2.5 2.5 4.5-5" stroke="#fff" stroke-width="2.2"/>',
};

export function icon(name, size = 22, sw = 2) {
  const s = document.createElement('span');
  s.className = 'icon';
  s.setAttribute('aria-hidden', 'true');
  s.innerHTML = `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round" focusable="false">${P[name] || ''}</svg>`;
  return s;
}

export function logo(size = 34) {
  const s = document.createElement('span');
  s.className = 'logo-mark';
  s.setAttribute('aria-hidden', 'true');
  s.innerHTML = `<svg width="${size}" height="${size}" viewBox="0 0 48 48"><rect width="48" height="48" rx="13" fill="#123b7a"/><path d="M19 15.5v17l14-8.5z" fill="#fff"/><circle cx="35.5" cy="12.5" r="4.5" fill="#e0ad45"/></svg>`;
  return s;
}

// ---------------- state & events ----------------
export const state = { config: null, me: null, muted: false };

export const bus = {
  map: new Map(),
  on(e, fn) {
    if (!this.map.has(e)) this.map.set(e, new Set());
    this.map.get(e).add(fn);
    return () => this.map.get(e).delete(fn);
  },
  emit(e, d) {
    for (const fn of this.map.get(e) || []) fn(d);
  },
};

// ---------------- API ----------------
export async function api(path, { method = 'GET', body, form } = {}) {
  let res;
  try {
    res = await fetch('/api' + path, {
      method,
      credentials: 'same-origin',
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: form || (body ? JSON.stringify(body) : undefined),
    });
  } catch {
    throw new Error(t('Network error. Check your connection and try again.'));
  }
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* no body */
  }
  if (!res.ok) {
    if (res.status === 503 && data && data.error === 'closed') bus.emit('closed', data);
    if (res.status === 401 && state.me) {
      state.me = null;
      bus.emit('auth');
    }
    const err = new Error((data && data.message) || t('Something went wrong. Please try again.'));
    err.status = res.status;
    err.code = data && data.error;
    throw err;
  }
  return data;
}

/** Upload with progress (multipart). */
export function upload(path, form, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api' + path);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress && onProgress(Math.round((e.loaded / e.total) * 100));
    xhr.onload = () => {
      let data = null;
      try {
        data = JSON.parse(xhr.responseText);
      } catch {
        /* not json */
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else reject(new Error((data && data.message) || t('Upload failed. Please try again.')));
    };
    xhr.onerror = () => reject(new Error(t('Network error. Check your connection and try again.')));
    xhr.send(form);
  });
}

/** Send a file's raw bytes with PUT (used for large video uploads to Lichtig). */
export function putFile(url, file, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress && onProgress(e.loaded / e.total);
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) return resolve();
      let msg = null;
      try {
        msg = JSON.parse(xhr.responseText).message;
      } catch {
        /* not json */
      }
      reject(new Error(msg || t('Upload failed. Please try again.')));
    };
    xhr.onerror = () => reject(new Error(t('Network error. Check your connection and try again.')));
    xhr.send(file);
  });
}

/** Grab a frame from a local video file to use as its thumbnail (JPEG Blob, or null). */
export function captureThumbnail(file) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const v = document.createElement('video');
    v.muted = true;
    v.playsInline = true;
    v.preload = 'auto';
    const done = (blob) => {
      clearTimeout(timer);
      URL.revokeObjectURL(url);
      resolve(blob || null);
    };
    const timer = setTimeout(() => done(null), 10000);
    v.addEventListener('loadedmetadata', () => {
      v.currentTime = Math.min(2, (v.duration || 2) / 3);
    });
    v.addEventListener('seeked', () => {
      try {
        const scale = Math.min(1, 960 / (v.videoWidth || 960));
        const c = document.createElement('canvas');
        c.width = Math.round((v.videoWidth || 960) * scale);
        c.height = Math.round((v.videoHeight || 540) * scale);
        c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
        c.toBlob((b) => done(b), 'image/jpeg', 0.82);
      } catch {
        done(null);
      }
    });
    v.addEventListener('error', () => done(null));
    v.src = url;
  });
}

/** Full upload flow for a video: reserve, send the file to Lichtig, then save the details. */
export async function uploadVideoFile({ file, fields, onProgress }) {
  const poster = await captureThumbnail(file);
  const slot = await api('/creator/uploads', { method: 'POST', body: { filename: file.name, size: file.size, mime: file.type } });
  await putFile(slot.uploadUrl, file, (p) => onProgress && onProgress(Math.round(p * 97)));
  const fd = new FormData();
  fd.append('mediaId', slot.mediaId);
  for (const [k, v] of Object.entries(fields)) fd.append(k, typeof v === 'boolean' ? (v ? '1' : '0') : v);
  if (poster) fd.append('poster', poster, 'poster.jpg');
  const res = await api('/creator/videos', { method: 'POST', form: fd });
  if (onProgress) onProgress(100);
  return res;
}

// ---------------- formatting ----------------
export function timeAgo(ms) {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return t('Just now');
  if (s < 3600) return t('{n}m ago', { n: Math.floor(s / 60) });
  if (s < 86400) return t('{n}h ago', { n: Math.floor(s / 3600) });
  return t('{n}d ago', { n: Math.floor(s / 86400) });
}
export function fmtCount(n) {
  n = n || 0;
  if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1e4) return (n / 1e3).toFixed(n >= 1e5 ? 0 : 1).replace(/\.0$/, '') + 'K';
  return n.toLocaleString('en-US');
}
export function fmtDuration(s) {
  if (!s) return '';
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return hh ? `${hh}:${String(mm).padStart(2, '0')}:${ss}` : `${mm}:${ss}`;
}
const YI_DAYS = ['זונטיק', 'מאנטיק', 'דינסטיק', 'מיטוואך', 'דאנערשטיק', 'פרייטיק', 'שבת'];
export const YI_DAYS_SHORT = ['זונ׳', 'מאנ׳', 'דינ׳', 'מיט׳', 'דאנ׳', 'פרייט׳', 'שבת'];

/** Weekday + time, shown in the given time zone (the zmanim city), not the viewer's. */
export function fmtTime(ms, timeZone) {
  const d = new Date(ms);
  const opts = timeZone ? { timeZone } : {};
  if (lang.current === 'yi') {
    const parts = new Intl.DateTimeFormat('en-US', { ...opts, weekday: 'short', hour: 'numeric', minute: '2-digit', hour12: true }).formatToParts(d);
    const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.find((p) => p.type === 'weekday').value);
    const hh = parts.find((p) => p.type === 'hour').value;
    const mm = parts.find((p) => p.type === 'minute').value;
    return `${YI_DAYS[wd]} ${hh}:${mm}`;
  }
  return d.toLocaleString(undefined, { ...opts, weekday: 'long', hour: 'numeric', minute: '2-digit' });
}
export function initials(name) {
  const parts = String(name || '?').trim().split(/\s+/).filter(Boolean);
  return (parts.length > 1 ? parts[0][0] + parts[1][0] : [...(parts[0] || '?')][0]).toUpperCase();
}

export function avatar(user, size = 44, { ring = null } = {}) {
  const inner = user && user.avatarUrl
    ? h('img', { src: user.avatarUrl, alt: '', loading: 'lazy' })
    : h('span', { class: 'avatar-initials' }, initials(user && (user.displayName || user.username)));
  return h(
    'span',
    { class: 'avatar' + (ring ? ' ring-' + ring : ''), style: { width: size + 'px', height: size + 'px' }, 'aria-hidden': 'true' },
    h('span', { class: 'avatar-inner' }, inner),
  );
}

export function verifiedBadge(user) {
  return user && user.verified ? h('span', { class: 'verified', title: t('Verified creator') }, icon('verified', 16)) : null;
}

// ---------------- toast ----------------
let toastTimer = null;
export function toast(msg, isError = false) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.toggle('error', isError);
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3200);
}

// ---------------- modal sheet ----------------
export const openSheets = [];
export function openSheet({ title, body, foot, wide = false, onClose }) {
  const prev = document.activeElement;
  const id = 'sh' + Math.random().toString(36).slice(2, 8);
  const titleEl = h('h2', { id }, title);
  const close = h('button', { type: 'button', class: 'icon-btn ghost', 'aria-label': t('Close') }, icon('x', 20));
  const sheet = h(
    'div',
    { class: 'sheet' + (wide ? ' wide' : ''), role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': id },
    h('div', { class: 'sheet-head' }, titleEl, close),
    h('div', { class: 'sheet-body' }, body),
    foot ? h('div', { class: 'sheet-foot' }, foot) : null,
  );
  const backdrop = h('div', { class: 'sheet-backdrop' });
  const handle = { close: doClose, el: sheet, titleEl };
  function onKey(e) {
    if (e.key === 'Escape') {
      e.stopPropagation();
      doClose();
    }
  }
  function doClose() {
    if (!sheet.isConnected) return;
    sheet.remove();
    backdrop.remove();
    document.removeEventListener('keydown', onKey, true);
    openSheets.splice(openSheets.indexOf(handle), 1);
    if (onClose) onClose();
    if (prev && prev.isConnected) prev.focus({ preventScroll: true });
  }
  close.addEventListener('click', doClose);
  backdrop.addEventListener('click', doClose);
  document.body.append(backdrop, sheet);
  document.addEventListener('keydown', onKey, true);
  openSheets.push(handle);
  close.focus({ preventScroll: true });
  return handle;
}

export function confirmSheet(message, { confirmText = t('Confirm'), danger = false } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const yes = h('button', { type: 'button', class: 'btn ' + (danger ? 'danger' : 'primary') }, confirmText);
    const no = h('button', { type: 'button', class: 'btn ghost' }, t('Cancel'));
    const s = openSheet({
      title: t('Are you sure?'),
      body: h('p', { class: 'muted' }, message),
      foot: h('div', { class: 'row-end' }, no, yes),
      onClose: () => !done && resolve(false),
    });
    yes.addEventListener('click', () => {
      done = true;
      s.close();
      resolve(true);
    });
    no.addEventListener('click', () => s.close());
  });
}

export function emptyState(title, text, action) {
  return h('div', { class: 'empty' }, h('h3', {}, title), text ? h('p', {}, text) : null, action || null);
}
export const spinner = () => h('div', { class: 'loading' }, h('span', { class: 'spinner' }));
