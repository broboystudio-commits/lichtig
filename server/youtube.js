// YouTube helpers. Videos are only ever shown through YouTube's own embedded player.
// oEmbed works without a key; the Data API (search, channel sync, durations) needs
// YOUTUBE_API_KEY.

const KEY = () => process.env.YOUTUBE_API_KEY || '';
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
    `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent('https://www.youtube.com/watch?v=' + id)}`,
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
