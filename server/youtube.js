// YouTube helpers. Videos are only ever shown through YouTube's own embedded player.
// oEmbed and each channel's public uploads feed work without a key; the Data API
// (search, durations, /@handle lookups) needs YOUTUBE_API_KEY.

const KEY = () => process.env.YOUTUBE_API_KEY || '';
const BASE = () => (process.env.YOUTUBE_BASE || 'https://www.youtube.com').replace(/\/$/, '');
export const hasApiKey = () => !!KEY();

export function parseVideoId(input) {
  const s = String(input || '').trim();
  if (/^[A-Za-z0-9_-]{11}$/.test(s)) return s;
  let url;
  try {
    url = new URL(s.startsWith('http') ? s : 'https://' + s);
  } catch {
    return null;
  }
  const host = url.hostname.replace(/^www\.|^m\./, '');
  let id = null;
  if (host === 'youtu.be') id = url.pathname.slice(1, 12);
  else if (host.endsWith('youtube.com') || host.endsWith('youtube-nocookie.com')) {
    if (url.searchParams.get('v')) id = url.searchParams.get('v');
    else {
      const m = url.pathname.match(/^\/(?:shorts|embed|live|v)\/([A-Za-z0-9_-]{11})/);
      if (m) id = m[1];
    }
  }
  return id && /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null;
}

export const thumbUrl = (id) => `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;

async function getJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(12000) });
  if (!res.ok) {
    const err = new Error(`YouTube request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

/** Title + channel for a video, without needing an API key. Throws if not embeddable. */
export async function oembed(id) {
  const data = await getJson(
    `${BASE()}/oembed?format=json&url=${encodeURIComponent('https://www.youtube.com/watch?v=' + id)}`,
  );
  return { title: data.title, channelName: data.author_name, channelUrl: data.author_url };
}

function isoDuration(s) {
  const m = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(s || '');
  if (!m) return null;
  return (+m[1] || 0) * 86400 + (+m[2] || 0) * 3600 + (+m[3] || 0) * 60 + (+m[4] || 0);
}

/** Full details for up to 50 videos (API key required). */
export async function videoDetails(ids) {
  if (!hasApiKey() || !ids.length) return new Map();
  const data = await getJson(
    `https://www.googleapis.com/youtube/v3/videos?part=snippet,contentDetails,status&id=${ids.join(',')}&key=${KEY()}`,
  );
  const map = new Map();
  for (const it of data.items || []) {
    map.set(it.id, {
      title: it.snippet.title,
      description: it.snippet.description || '',
      channelName: it.snippet.channelTitle,
      channelId: it.snippet.channelId,
      duration: isoDuration(it.contentDetails?.duration),
      embeddable: it.status?.embeddable !== false,
      publishedAt: it.snippet.publishedAt,
    });
  }
  return map;
}

export async function search(q) {
  if (!hasApiKey()) throw Object.assign(new Error('Add a YouTube API key to search YouTube.'), { status: 400 });
  const data = await getJson(
    `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&videoEmbeddable=true&safeSearch=strict&maxResults=12&q=${encodeURIComponent(q)}&key=${KEY()}`,
  );
  return (data.items || []).map((it) => ({
    id: it.id.videoId,
    title: it.snippet.title,
    channelName: it.snippet.channelTitle,
    thumbnail: thumbUrl(it.id.videoId),
  }));
}

/** Resolve a channel URL (/@handle, /channel/UC…) to id, name, uploads playlist. */
export async function resolveChannel(url) {
  if (!hasApiKey()) return null;
  let param = null;
  const handle = /youtube\.com\/@([\w.-]+)/.exec(url);
  const chan = /youtube\.com\/channel\/(UC[\w-]{20,})/.exec(url);
  if (handle) param = 'forHandle=' + encodeURIComponent('@' + handle[1]);
  else if (chan) param = 'id=' + chan[1];
  else return null;
  const data = await getJson(
    `https://www.googleapis.com/youtube/v3/channels?part=snippet,contentDetails&${param}&key=${KEY()}`,
  );
  const it = data.items && data.items[0];
  if (!it) return null;
  return {
    id: it.id,
    name: it.snippet.title,
    thumbnail: it.snippet.thumbnails?.default?.url || '',
    uploads: it.contentDetails?.relatedPlaylists?.uploads,
  };
}

export async function latestUploads(uploadsPlaylistId, max = 15) {
  const data = await getJson(
    `https://www.googleapis.com/youtube/v3/playlistItems?part=contentDetails&maxResults=${max}&playlistId=${uploadsPlaylistId}&key=${KEY()}`,
  );
  return (data.items || []).map((it) => it.contentDetails.videoId);
}

/** The UC… channel id in a youtube.com/channel/UC… link (or a bare id), if there is one. */
export function channelIdFromUrl(url) {
  const s = String(url || '').trim();
  if (/^UC[\w-]{22}$/.test(s)) return s;
  const m = /youtube\.com\/channel\/(UC[\w-]{22})(?:[/?#]|$)/.exec(s);
  return m ? m[1] : null;
}

const decodeXml = (s) =>
  String(s || '')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');

const tag = (xml, name) => {
  const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`).exec(xml);
  return m ? decodeXml(m[1].trim()) : '';
};

/**
 * Latest uploads from a channel's public feed (no API key needed).
 * Returns { name, ids, details } where details is a Map like videoDetails() gives.
 */
export async function feedUploads(channelId, max = 15) {
  const res = await fetch(`${BASE()}/feeds/videos.xml?channel_id=${encodeURIComponent(channelId)}`, {
    signal: AbortSignal.timeout(12000),
  });
  if (res.status === 404) throw Object.assign(new Error('YouTube has no channel with that ID.'), { status: 400 });
  if (!res.ok) throw Object.assign(new Error(`YouTube's channel feed didn't answer (${res.status}). Try again later.`), { status: 502 });
  const xml = await res.text();
  const head = xml.split('<entry')[0];
  const details = new Map();
  const ids = [];
  for (const entry of xml.split('<entry').slice(1)) {
    const id = tag(entry, 'yt:videoId');
    if (!/^[A-Za-z0-9_-]{11}$/.test(id) || details.has(id)) continue;
    ids.push(id);
    details.set(id, {
      title: tag(entry, 'media:title') || tag(entry, 'title'),
      description: tag(entry, 'media:description'),
      publishedAt: tag(entry, 'published'),
    });
    if (ids.length >= max) break;
  }
  return { name: tag(head, 'title'), ids, details };
}
