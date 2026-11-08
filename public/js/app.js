import {
  h, fill, icon, logo, api, upload, t, lang, setLang, catName, state, bus, toast, openSheet, confirmSheet,
  timeAgo, fmtCount, fmtDuration, fmtTime, YI_DAYS_SHORT, avatar, verifiedBadge, emptyState, spinner, openSheets,
} from './core.js';
import { openStories, createShorts, downloadMedia, reportContent, toggleFollow, isSeenLocally } from './stories.js';

const main = document.getElementById('main');
const topbar = document.getElementById('topbar');
const sidebar = document.getElementById('sidebar');
const bottomNav = document.getElementById('bottom-nav');
let cleanup = null;
let categories = [];

// =====================================================================
// Shell: header, sidebar, bottom nav
// =====================================================================
function renderTopbar() {
  const me = state.me;
  const q = h('input', {
    type: 'search',
    name: 'q',
    placeholder: t('Search videos, creators…'),
    'aria-label': t('Search'),
    autocomplete: 'off',
    enterkeyhint: 'search',
  });
  const form = h('form', { class: 'search-box', role: 'search' }, icon('search', 18), q);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const v = q.value.trim();
    if (v) location.hash = '#/search?q=' + encodeURIComponent(v);
  });
  const langBtn = h(
    'button',
    { type: 'button', class: 'lang-toggle', 'aria-label': t('Language'), title: t('Language') },
    h('span', { class: lang.current === 'en' ? 'on' : '' }, 'EN'),
    h('span', { class: lang.current === 'yi' ? 'on' : '' }, 'אידיש'),
  );
  langBtn.addEventListener('click', () => switchLang(lang.current === 'en' ? 'yi' : 'en'));
  const shield = state.config?.filters?.locked
    ? h('a', { class: 'icon-btn tint', href: '#/account', title: t('Parental controls are on'), 'aria-label': t('Parental controls are on') }, icon('shield', 20))
    : null;
  fill(
    topbar,
    h('a', { class: 'brand', href: '#/', 'aria-label': state.config?.siteName || 'Lichtig' }, logo(34), h('span', { class: 'brand-text' }, h('strong', {}, state.config?.siteName || 'Lichtig'), h('small', {}, 'ליכטיג'))),
    form,
    h(
      'div',
      { class: 'top-actions' },
      h('a', { class: 'icon-btn mobile-only', href: '#/search', 'aria-label': t('Search') }, icon('search', 20)),
      langBtn,
      shield,
      me ? h('a', { class: 'btn primary small hide-mobile', href: '#/post' }, icon('plus', 18), t('Post a short')) : null,
      me
        ? h('a', { class: 'me-link', href: '#/account', 'aria-label': t('Your account') }, avatar(me, 36))
        : h('a', { class: 'btn primary small', href: '#/login' }, t('Sign in')),
    ),
  );
}

const NAV = () => [
  ['home', '#/', 'Home', 'home'],
  ['shorts', '#/shorts', 'Shorts', 'shorts'],
  ['status', '#/status', 'Statuses', 'status'],
  ['saved', '#/saved', 'Saved', 'bookmark'],
  ['premium', '#/premium', 'Premium', 'crown'],
];

function renderSidebar(active) {
  const item = ([key, href, label, ic]) =>
    h('a', { class: 'side-link', href, 'aria-current': active === key ? 'page' : null }, icon(ic, 21), h('span', {}, t(label)));
  fill(
    sidebar,
    h('nav', { 'aria-label': t('Main') }, NAV().map(item)),
    h('div', { class: 'side-sep' }),
    h('p', { class: 'side-title' }, t('Explore')),
    h(
      'nav',
      { 'aria-label': t('Categories') },
      categories.map((c) =>
        h('a', { class: 'side-link small', href: '#/c/' + c.slug, 'aria-current': active === 'c:' + c.slug ? 'page' : null }, h('span', { class: 'dot' }), h('span', {}, catName(c))),
      ),
    ),
    h('div', { class: 'side-sep' }),
    state.me && state.me.role === 'admin'
      ? h('a', { class: 'side-link', href: '#/admin', 'aria-current': active === 'admin' ? 'page' : null }, icon('settings', 21), h('span', {}, t('Admin')))
      : null,
    h('a', { class: 'side-link', href: state.me ? '#/account' : '#/login', 'aria-current': active === 'account' ? 'page' : null }, icon('user', 21), h('span', {}, state.me ? t('Account') : t('Sign in'))),
    h('p', { class: 'side-foot' }, t('Kosher videos and statuses for the whole family.')),
  );
}

function renderBottomNav(active) {
  const item = ([key, href, label, ic]) =>
    h('a', { href, class: 'bn-item', 'aria-current': active === key ? 'page' : null }, icon(ic, 22), h('span', {}, t(label)));
  fill(
    bottomNav,
    item(['home', '#/', 'Home', 'home']),
    item(['shorts', '#/shorts', 'Shorts', 'shorts']),
    h('a', { href: state.me ? '#/post' : '#/login', class: 'bn-post', 'aria-label': t('Post a short') }, icon('plus', 24, 2.4)),
    item(['status', '#/status', 'Statuses', 'status']),
    item(['saved', '#/saved', 'Saved', 'bookmark']),
  );
}

async function switchLang(next) {
  setLang(next);
  if (state.me) api('/me', { method: 'PATCH', body: { lang: next } }).catch(() => {});
  route();
}

// =====================================================================
// Shared UI pieces
// =====================================================================
function videoCard(v, { size = '' } = {}) {
  const thumb = v.thumbnail
    ? h('img', {
        src: v.thumbnail,
        alt: '',
        loading: 'lazy',
        // If thumbnails are blocked (e.g. by a filter), show a branded placeholder instead of a broken image.
        onerror: (e) => e.currentTarget.replaceWith(h('span', { class: 'thumb-ph' }, logo(30))),
      })
    : v.mediaUrl
      ? (() => {
          const el = h('video', { preload: 'metadata', muted: true, playsinline: true, tabindex: '-1', 'aria-hidden': 'true' });
          el.muted = true;
          el.src = v.mediaUrl + '#t=1';
          return el;
        })()
      : h('span', { class: 'thumb-ph' }, icon('tv', 34));
  return h(
    'a',
    { class: 'vcard ' + size, href: '#/v/' + v.id },
    h(
      'span',
      { class: 'thumb' },
      thumb,
      v.durationS ? h('span', { class: 'badge-time' }, fmtDuration(v.durationS)) : null,
      v.flags.kidSafe ? h('span', { class: 'badge-kids' }, t('Kids')) : null,
      v.source === 'upload' ? h('span', { class: 'badge-own' }, logo(14), t('Original')) : null,
    ),
    h('span', { class: 'vcard-body' }, h('span', { class: 'vcard-title', dir: 'auto' }, v.title), h('span', { class: 'vcard-meta', dir: 'auto' }, v.channelName)),
  );
}

function adBanner(ad, { compact = false } = {}) {
  if (!ad) return null;
  api(`/ads/${ad.id}/impression`, { method: 'POST' }).catch(() => {});
  const media = ad.mime && ad.mime.startsWith('video/')
    ? h('video', { src: ad.mediaUrl, autoplay: true, muted: true, loop: true, playsinline: true, 'aria-label': ad.title })
    : h('img', { src: ad.mediaUrl, alt: ad.title, loading: 'lazy' });
  return h(
    'aside',
    { class: 'ad-banner' + (compact ? ' compact' : ''), 'aria-label': t('Sponsored') },
    h('a', { href: ad.href, target: '_blank', rel: 'noopener sponsored', class: 'ad-media' }, media),
    h('div', { class: 'ad-foot' }, h('span', { class: 'ad-pill' }, t('Sponsored')), h('a', { href: '#/premium' }, t('Remove ads with Premium'))),
  );
}

function sectionHead(title, href) {
  return h('div', { class: 'section-head' }, h('h2', {}, title), href ? h('a', { href, class: 'see-all' }, t('See all'), icon('next', 16)) : null);
}

function dayRange(daysAgo = 0) {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - daysAgo);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return { from: start, to: end };
}

function unseenCount(c) {
  if (state.me) return c.unseen;
  return c.ids.filter((id) => !isSeenLocally(id)).length;
}

const yidStatusAllowed = () => !state.config.filters.kidsMode && !state.config.filters.hideStatuses;

function yidStatusCard() {
  if (!yidStatusAllowed()) return null;
  return h(
    'a',
    { class: 'ys-card', href: '#/status' },
    h('span', { class: 'ys-badge' }, icon('status', 22)),
    h('span', { class: 'ys-text' }, h('strong', {}, t('Today’s statuses')), h('span', {}, t('From YidStatus.com'))),
    icon('next', 18),
  );
}

function shortsTabs(active, dark = false) {
  return h(
    'div',
    { class: 'shorts-tabs' + (dark ? ' dark' : ''), role: 'tablist', 'aria-label': t('Shorts') },
    h('a', { href: '#/shorts', role: 'tab', 'aria-selected': String(active === 'feed') }, t('Feed')),
    h('a', { href: '#/shorts/creators', role: 'tab', 'aria-selected': String(active === 'creators') }, t('Creators')),
  );
}

function needLogin(message) {
  return h(
    'div',
    { class: 'empty' },
    icon('user', 40),
    h('h3', {}, t('Sign in to continue')),
    h('p', {}, message),
    h('a', { class: 'btn primary', href: '#/login' }, t('Sign in')),
  );
}

// =====================================================================
// Home
// =====================================================================
function renderHome() {
  const cfg = state.config;
  const page = h('div', { class: 'page home' });
  fill(main, page);

  const dateStrip = h(
    'div',
    { class: 'date-strip' },
    icon('calendar', 18),
    h('span', { class: 'he', lang: 'he', dir: 'rtl' }, cfg.hebrewDate.he),
    h('span', { class: 'sep' }, '·'),
    h('span', {}, cfg.hebrewDate.en),
    cfg.shabbosEnabled && cfg.closed.nextCandleLighting
      ? [h('span', { class: 'sep' }, '·'), h('span', { class: 'candle' }, icon('candle', 16), t('Candle lighting {time}', { time: fmtTime(cfg.closed.nextCandleLighting, cfg.closed.tzid) }), ` (${cfg.closed.city})`)]
      : null,
  );
  const chips = h(
    'div',
    { class: 'chips', role: 'list' },
    h('a', { class: 'chip on', href: '#/', role: 'listitem' }, t('All')),
    categories.map((c) => h('a', { class: 'chip', href: '#/c/' + c.slug, role: 'listitem' }, catName(c))),
  );
  const body = h('div', {}, spinner());
  append(page, [
    cfg.announcement ? h('div', { class: 'announcement', dir: 'auto' }, icon('megaphone', 18), cfg.announcement) : null,
    dateStrip,
    shortsTeaser(),
    chips,
    body,
  ]);

  api('/home')
    .then((d) => {
      const blocks = [];
      if (d.ads && d.ads[0]) blocks.push(adBanner(d.ads[0]));
      if (d.featured.length) {
        blocks.push(h('section', { class: 'featured' }, sectionHead(t('Featured')), h('div', { class: 'hero-row' }, d.featured.map((v) => videoCard(v, { size: 'large' })))));
      }
      blocks.push(yidStatusCard());
      d.sections.forEach((s, i) => {
        blocks.push(h('section', { class: 'row-section' }, sectionHead(lang.current === 'yi' ? s.nameYi : s.nameEn, '#/c/' + s.slug), h('div', { class: 'card-row' }, s.videos.map((v) => videoCard(v)))));
        if (i === 1 && d.ads && d.ads[1]) blocks.push(adBanner(d.ads[1], { compact: true }));
      });
      if (!d.sections.length && !d.featured.length) {
        blocks.push(emptyState(t('No videos to show'), cfg.filters.locked ? t('Parental controls may be hiding some videos.') : t('Videos added by the admin will appear here.')));
      }
      fill(body, blocks);
    })
    .catch((err) => fill(body, emptyState(t('Could not load videos'), err.message)));
}

function append(el, children) {
  for (const c of children.flat(Infinity)) if (c) el.append(c);
}

function shortsTeaser() {
  if (state.config.filters.hideShorts) return null;
  const row = h('div', { class: 'shorts-row' }, spinner());
  const sec = h('section', { class: 'row-section shorts-section' }, sectionHead(t('Shorts'), '#/shorts'), row);
  api('/shorts')
    .then(({ shorts }) => {
      const post = state.me
        ? h('a', { class: 'short-card post-card', href: '#/post' }, h('span', { class: 'post-card-inner' }, h('span', { class: 'add-ring' }, icon('plus', 26)), h('strong', {}, t('Post a short'))))
        : null;
      if (!shorts.length && !post) return sec.remove();
      fill(
        row,
        post,
        shorts.slice(0, 12).map((s) => {
          const v = h('video', { preload: 'metadata', muted: true, playsinline: true, tabindex: '-1', 'aria-hidden': 'true' });
          v.muted = true;
          v.src = s.mediaUrl + '#t=0.5';
          return h(
            'a',
            { class: 'short-card', href: '#/shorts?id=' + s.id, 'aria-label': `${s.user.displayName}: ${s.body || t('Short')}` },
            v,
            h('span', { class: 'short-card-info' }, avatar(s.user, 24), h('span', { dir: 'auto' }, s.body || s.user.displayName)),
          );
        }),
      );
    })
    .catch(() => sec.remove());
  return sec;
}

// =====================================================================
// Category, search, saved
// =====================================================================
function renderCategory(slug) {
  const c = categories.find((x) => x.slug === slug);
  const grid = h('div', { class: 'grid' });
  const more = h('button', { type: 'button', class: 'btn ghost', hidden: true }, t('Load more'));
  let offset = 0;
  fill(
    main,
    h(
      'div',
      { class: 'page' },
      h('div', { class: 'chips' }, h('a', { class: 'chip', href: '#/' }, t('All')), categories.map((x) => h('a', { class: 'chip' + (x.slug === slug ? ' on' : ''), href: '#/c/' + x.slug }, catName(x)))),
      h('h1', { class: 'page-title' }, c ? catName(c) : t('Videos')),
      grid,
      h('div', { class: 'center' }, more),
    ),
  );
  const load = async () => {
    more.disabled = true;
    try {
      const d = await api(`/videos?category=${encodeURIComponent(slug)}&offset=${offset}`);
      if (!offset && !d.videos.length) grid.replaceWith(emptyState(t('No videos here yet'), state.config.filters.locked ? t('Parental controls may be hiding some videos.') : ''));
      d.videos.forEach((v) => grid.append(videoCard(v)));
      offset += d.videos.length;
      more.hidden = !d.more;
    } catch (err) {
      toast(err.message, true);
    } finally {
      more.disabled = false;
    }
  };
  more.addEventListener('click', load);
  load();
}

function renderSearch(params) {
  const q = (params.get('q') || '').trim();
  const input = h('input', { type: 'search', value: q, placeholder: t('Search videos, creators…'), 'aria-label': t('Search'), class: 'input' });
  const form = h('form', { class: 'search-page-form', role: 'search' }, input, h('button', { class: 'btn primary', type: 'submit' }, icon('search', 18), t('Search')));
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    location.hash = '#/search?q=' + encodeURIComponent(input.value.trim());
  });
  const results = h('div', {}, q ? spinner() : emptyState(t('Search Lichtig'), t('Find videos, channels and creators.')));
  fill(main, h('div', { class: 'page' }, h('h1', { class: 'page-title' }, t('Search')), form, results));
  if (!q) return input.focus();
  api('/search?q=' + encodeURIComponent(q))
    .then((d) => {
      const blocks = [];
      if (d.creators.length) {
        blocks.push(sectionHead(t('Creators')), h('div', { class: 'creator-row' }, d.creators.map((u) => h('a', { class: 'creator-chip', href: '#/u/' + encodeURIComponent(u.username) }, avatar(u, 40), h('span', { dir: 'auto' }, u.displayName), verifiedBadge(u)))));
      }
      if (d.videos.length) blocks.push(sectionHead(t('Videos')), h('div', { class: 'grid' }, d.videos.map((v) => videoCard(v))));
      if (!blocks.length) blocks.push(emptyState(t('No results'), t('Nothing matches “{q}”.', { q })));
      fill(results, blocks);
    })
    .catch((err) => fill(results, emptyState(t('Search failed'), err.message)));
}

function renderSaved() {
  if (!state.me) return fill(main, h('div', { class: 'page' }, needLogin(t('Save videos and add your favorite creators.'))));
  const body = h('div', {}, spinner());
  fill(main, h('div', { class: 'page' }, h('h1', { class: 'page-title' }, t('Saved')), body));
  api('/me/saved')
    .then((d) => {
      fill(
        body,
        sectionHead(t('Favorite creators')),
        d.creators.length
          ? h('div', { class: 'creator-row' }, d.creators.map((u) => h('a', { class: 'creator-chip', href: '#/u/' + encodeURIComponent(u.username) }, avatar(u, 40), h('span', { dir: 'auto' }, u.displayName), verifiedBadge(u))))
          : h('p', { class: 'muted' }, t('Tap “Add to favorites” on a creator’s short to see them here first.')),
        sectionHead(t('Saved videos')),
        d.videos.length ? h('div', { class: 'grid' }, d.videos.map((v) => videoCard(v))) : h('p', { class: 'muted' }, t('Tap Save under any video to keep it here.')),
      );
    })
    .catch((err) => fill(body, emptyState(t('Could not load'), err.message)));
}

// =====================================================================
// Watch
// =====================================================================
let ytApiPromise = null;
function loadYouTubeApi() {
  if (window.YT && window.YT.Player) return Promise.resolve(window.YT);
  if (!ytApiPromise) {
    ytApiPromise = new Promise((resolve, reject) => {
      const prev = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = () => {
        if (prev) prev();
        resolve(window.YT);
      };
      const s = document.createElement('script');
      s.src = 'https://www.youtube.com/iframe_api';
      s.async = true;
      s.onerror = () => {
        ytApiPromise = null;
        reject(new Error('YouTube player failed to load'));
      };
      document.head.append(s);
      setTimeout(() => reject(new Error('YouTube player timed out')), 7000);
    });
  }
  return ytApiPromise;
}

/**
 * A Lichtig-branded cover for YouTube videos: our own thumbnail, title and play button.
 * YouTube's player only loads (and starts) once the viewer taps play, and our "Up next"
 * screen replaces YouTube's end-of-video suggestions.
 */
function youTubePlayer(v, related) {
  const box = h('div', { class: 'player yt-facade' });
  const poster = h('img', { class: 'facade-poster', src: `https://i.ytimg.com/vi/${v.ytId}/maxresdefault.jpg`, alt: '' });
  poster.addEventListener('error', () => {
    if (poster.dataset.fallback) {
      poster.remove(); // thumbnails blocked too: keep the branded background
      box.classList.add('no-poster');
      return;
    }
    poster.dataset.fallback = '1';
    poster.src = `https://i.ytimg.com/vi/${v.ytId}/hqdefault.jpg`;
  });
  const playBtn = h('button', { type: 'button', class: 'facade-play', 'aria-label': t('Play video') }, h('span', { class: 'facade-btn' }, icon('play', 34)));
  const shade = h(
    'div',
    { class: 'facade-shade', 'aria-hidden': 'true' },
    h('span', { class: 'facade-brand' }, logo(20), h('span', {}, state.config.siteName)),
    h('span', { class: 'facade-title', dir: 'auto' }, v.title),
  );
  fill(box, poster, shade, playBtn);
  let player = null;
  let revealTimer = null;

  // Shown when YouTube can't load (for example a kosher filter blocks it) or the video errors.
  const showUnavailable = (blocked) => {
    clearTimeout(revealTimer);
    try {
      if (player && player.destroy) player.destroy();
    } catch {
      /* already gone */
    }
    fill(
      box,
      h(
        'div',
        { class: 'yt-unavailable' },
        icon(blocked ? 'shield' : 'tv', 36),
        h('strong', {}, blocked ? t('This video can’t play on this device') : t('This video isn’t available right now')),
        h('p', {}, blocked ? t('It plays from YouTube, which is blocked here (for example by a kosher filter). Lichtig Shorts and original videos still work.') : t('Try another video.')),
        h('div', { class: 'end-actions' }, h('a', { class: 'btn light small', href: '#/shorts' }, icon('shorts', 16), t('Watch Shorts')), h('a', { class: 'btn ghost-light small', href: '#/' }, t('Back to home'))),
      ),
    );
    box.classList.add('playing', 'unavailable');
  };

  const showEnd = () => {
    const next = related[0];
    const overlay = h(
      'div',
      { class: 'end-overlay' },
      next
        ? h('a', { class: 'end-next', href: '#/v/' + next.id }, h('span', { class: 'end-label' }, t('Up next')), next.thumbnail ? h('img', { src: next.thumbnail, alt: '' }) : null, h('strong', { dir: 'auto' }, next.title))
        : null,
      h(
        'div',
        { class: 'end-actions' },
        h(
          'button',
          {
            type: 'button',
            class: 'btn light small',
            onclick: () => {
              overlay.remove();
              player.seekTo(0, true);
              player.playVideo();
            },
          },
          icon('refresh', 16),
          t('Watch again'),
        ),
        next ? h('a', { class: 'btn gold small', href: '#/v/' + next.id }, icon('play', 14), t('Play next')) : null,
      ),
    );
    box.append(overlay);
  };

  playBtn.addEventListener('click', async () => {
    box.classList.add('loading');
    const holder = h('div', { class: 'yt-holder' });
    box.prepend(holder);
    // If YouTube needs one more tap (some phones block autoplay), reveal its player after a moment.
    revealTimer = setTimeout(() => box.classList.add('playing'), 3500);
    try {
      const YT = await loadYouTubeApi();
      player = new YT.Player(holder, {
        videoId: v.ytId,
        host: 'https://www.youtube-nocookie.com',
        playerVars: { autoplay: 1, rel: 0, playsinline: 1, iv_load_policy: 3, modestbranding: 1, hl: lang.current === 'yi' ? 'yi' : 'en', origin: location.origin },
        events: {
          onReady: (e) => e.target.playVideo(),
          onStateChange: (e) => {
            if (e.data === 1) {
              clearTimeout(revealTimer);
              box.classList.add('playing');
              box.querySelector('.end-overlay')?.remove();
            }
            if (e.data === 0) showEnd();
          },
          onError: () => showUnavailable(false),
        },
      });
    } catch {
      showUnavailable(true);
    }
  });

  return {
    el: box,
    destroy() {
      clearTimeout(revealTimer);
      try {
        if (player && player.destroy) player.destroy();
      } catch {
        /* already gone */
      }
    },
  };
}

function renderWatch(id) {
  const page = h('div', { class: 'page watch' }, spinner());
  fill(main, page);
  let ytp = null;
  api('/videos/' + id)
    .then((d) => {
      const v = d.video;
      api(`/videos/${id}/view`, { method: 'POST' }).catch(() => {});
      let player;
      if (v.source === 'youtube') {
        ytp = youTubePlayer(v, d.related);
        player = ytp.el;
      } else {
        player = h('div', { class: 'player' }, h('video', { src: v.mediaUrl, controls: true, autoplay: true, playsinline: true, controlslist: d.canDownload ? null : 'nodownload' }));
      }

      let liked = v.liked;
      let saved = v.saved;
      let likes = v.likes;
      const likeBtn = h('button', { type: 'button', class: 'act-btn' });
      const saveBtn = h('button', { type: 'button', class: 'act-btn' });
      const paint = () => {
        fill(likeBtn, icon('heart', 20), h('span', {}, fmtCount(likes)));
        likeBtn.setAttribute('aria-pressed', String(liked));
        likeBtn.setAttribute('aria-label', liked ? t('Unlike') : t('Like'));
        fill(saveBtn, icon('bookmark', 20), h('span', {}, saved ? t('Saved') : t('Save')));
        saveBtn.setAttribute('aria-pressed', String(saved));
      };
      paint();
      const toggle = async (kind) => {
        if (!state.me) {
          toast(t('Sign in to like and save videos.'));
          location.hash = '#/login';
          return;
        }
        const on = kind === 'like' ? liked : saved;
        try {
          const r = await api(`/videos/${id}/${kind}`, { method: on ? 'DELETE' : 'POST' });
          liked = r.liked;
          saved = r.saved;
          likes = r.likes;
          paint();
          if (kind === 'save' && saved) toast(t('Saved'));
        } catch (err) {
          toast(err.message, true);
        }
      };
      likeBtn.addEventListener('click', () => toggle('like'));
      saveBtn.addEventListener('click', () => toggle('save'));
      const shareBtn = h('button', { type: 'button', class: 'act-btn' }, icon('share', 20), h('span', {}, t('Share')));
      shareBtn.addEventListener('click', async () => {
        const url = location.origin + '/#/v/' + id;
        try {
          if (navigator.share) await navigator.share({ title: v.title, url });
          else {
            await navigator.clipboard.writeText(url);
            toast(t('Link copied'));
          }
        } catch {
          /* cancelled */
        }
      });
      const dlBtn = v.source === 'upload'
        ? h('button', { type: 'button', class: 'act-btn', onclick: () => downloadMedia(v.mediaUrl) }, icon('download', 20), h('span', {}, t('Download')), state.me?.premium ? null : icon('crown', 14))
        : null;
      const reportBtn = h('button', { type: 'button', class: 'act-btn', onclick: () => reportContent('video', v.id) }, icon('flag', 20), h('span', {}, t('Report')));
      const desc = v.description ? h('details', { class: 'desc' }, h('summary', {}, t('Description')), h('p', { dir: 'auto' }, v.description)) : null;

      fill(
        page,
        h(
          'div',
          { class: 'watch-main' },
          player,
          h('h1', { class: 'watch-title', dir: 'auto' }, v.title),
          h(
            'div',
            { class: 'watch-bar' },
            h('div', { class: 'channel' }, h('span', { class: 'channel-avatar' }, v.source === 'upload' ? logo(36) : icon('tv', 20)), h('div', {}, h('strong', { dir: 'auto' }, v.channelName), h('span', { class: 'muted small' }, [v.category ? catName(v.category) : null, t('{n} views', { n: fmtCount(v.views) })].filter(Boolean).join(' · ')))),
            h('div', { class: 'actions' }, likeBtn, saveBtn, shareBtn, dlBtn, reportBtn),
          ),
          d.ads && d.ads[0] ? adBanner(d.ads[0], { compact: true }) : null,
          desc,
        ),
        h('aside', { class: 'watch-side' }, h('h2', { class: 'side-head' }, t('Up next')), h('div', { class: 'list' }, d.related.map((r) => videoCard(r, { size: 'row' })))),
      );
    })
    .catch((err) => {
      fill(page, err.code === 'filtered' ? emptyState(t('Hidden by parental controls'), t('This video is not available with your current settings.'), h('a', { class: 'btn ghost', href: '#/' }, t('Back to home'))) : emptyState(t('Video not found'), err.message, h('a', { class: 'btn ghost', href: '#/' }, t('Back to home'))));
    });
  return () => ytp && ytp.destroy();
}

// =====================================================================
// Statuses (yidstatus-style)
// =====================================================================
function renderShortsCreators(params) {
  let day = Math.min(7, Math.max(0, Number(params.get('day')) || 0));
  const tab = params.get('tab') === 'favorites' ? 'favorites' : 'all';
  const list = h('div', { class: 'status-list' }, spinner());
  const dayNames = (d) => (lang.current === 'yi' ? YI_DAYS_SHORT[new Date(d).getDay()] : new Date(d).toLocaleDateString(undefined, { weekday: 'short' }));
  const days = h(
    'div',
    { class: 'day-strip', role: 'tablist', 'aria-label': t('Day') },
    h('span', { class: 'day-icon' }, icon('calendar', 20)),
    Array.from({ length: 8 }, (_, i) => 7 - i).map((ago) => {
      const { from } = dayRange(ago);
      const label = ago === 0 ? t('Today') : ago === 1 ? t('Yest') : dayNames(from);
      return h('a', { class: 'day' + (ago === day ? ' on' : ''), href: `#/shorts/creators?day=${ago}&tab=${tab}`, role: 'tab', 'aria-selected': String(ago === day) }, h('span', {}, label), h('strong', {}, from.getDate()));
    }),
  );
  const tabs = h(
    'div',
    { class: 'pill-tabs' },
    h('a', { class: 'pill' + (tab === 'all' ? ' on' : ''), href: `#/shorts/creators?day=${day}&tab=all` }, t('All creators')),
    h('a', { class: 'pill' + (tab === 'favorites' ? ' on' : ''), href: `#/shorts/creators?day=${day}&tab=favorites` }, t('Favorites')),
  );
  fill(
    main,
    h(
      'div',
      { class: 'page statuses' },
      h('div', { class: 'status-head' }, h('h1', { class: 'page-title' }, t('Shorts')), shortsTabs('creators')),
      days,
      tabs,
      h('a', { class: 'my-status-row', href: state.me ? '#/post' : '#/login' }, h('span', { class: 'add-ring small' }, icon('plus', 20)), h('span', {}, h('strong', {}, t('Post a short')), h('span', { class: 'muted small' }, state.me ? t('Share a short video with the community') : t('Sign in to post a short')))),
      h('h2', { class: 'list-label' }, t('Recent')),
      list,
    ),
  );
  setTimeout(() => days.querySelector('.day.on')?.scrollIntoView({ inline: 'center', block: 'nearest' }), 0);
  if (tab === 'favorites' && !state.me) return fill(list, needLogin(t('Add creators to your favorites to see them here.')));
  if (state.config.filters.hideShorts) return fill(list, emptyState(t('Shorts are hidden'), t('Parental controls on this device hide shorts.')));
  const range = dayRange(day);
  api(`/statuses?from=${range.from.toISOString()}&to=${range.to.toISOString()}${tab === 'favorites' ? '&tab=following' : ''}`)
    .then(({ creators }) => {
      if (!creators.length) return fill(list, emptyState(tab === 'favorites' ? t('No shorts from your favorites') : t('No shorts on this day'), t('Try another day.')));
      fill(
        list,
        creators.map((c, i) => {
          const unseen = unseenCount(c);
          return h(
            'button',
            { type: 'button', class: 'status-row', onclick: () => openStories({ creators, start: i, ...range, onClose: () => route() }) },
            avatar(c.user, 56, { ring: unseen > 0 ? 'new' : 'seen' }),
            h(
              'span',
              { class: 'status-row-body' },
              h('span', { class: 'status-row-top' }, h('strong', { dir: 'auto' }, c.user.displayName), verifiedBadge(c.user), h('span', { class: 'time' }, timeAgo(c.latestAt))),
              h('span', { class: 'status-row-sub' }, icon('video', 15), h('span', { dir: 'auto' }, c.count > 1 ? (unseen > 1 ? t('{n} new shorts', { n: unseen }) : t('{n} shorts', { n: c.count })) : c.preview.text || t('Short'))),
            ),
          );
        }),
      );
    })
    .catch((err) => fill(list, emptyState(t('Could not load shorts'), err.message)));
}

function renderYidStatus() {
  if (!yidStatusAllowed()) {
    return fill(main, h('div', { class: 'page narrow' }, emptyState(t('Statuses are hidden'), t('Parental controls on this device hide the Statuses section.'))));
  }
  fill(
    main,
    h(
      'div',
      { class: 'page narrow' },
      h('h1', { class: 'page-title' }, t('Statuses')),
      h(
        'div',
        { class: 'card ys-hero' },
        h('span', { class: 'ys-wordmark', 'aria-hidden': 'true' }, 'yidstatus', h('span', {}, '.com')),
        h('p', {}, t('Statuses come from YidStatus.com, where heimish creators and businesses post their daily WhatsApp statuses.')),
        h('a', { class: 'btn primary', href: 'https://yidstatus.com', target: '_blank', rel: 'noopener' }, t('Open YidStatus.com'), icon('link', 16)),
        h('p', { class: 'muted small' }, t('YidStatus is a separate website. Lichtig’s kosher filters and parental controls don’t apply there.')),
      ),
      h(
        'div',
        { class: 'card' },
        h('h2', {}, icon('shorts', 20), ' ', t('Have something to share?')),
        h('p', { class: 'muted' }, t('Post a short video on Lichtig. Our team reviews every short before it goes live.')),
        h('a', { class: 'btn ghost', href: state.me ? '#/post' : '#/login' }, icon('plus', 18), t('Post a short')),
      ),
    ),
  );
}

function renderShorts(params) {
  const box = h('div', { class: 'shorts-page' });
  fill(main, box);
  if (state.config.filters.hideShorts) {
    return fill(box, h('div', { class: 'empty light' }, h('h3', {}, t('Shorts are hidden')), h('p', {}, t('Parental controls on this device hide shorts.'))));
  }
  const feed = h('div', { class: 'shorts-feed' });
  box.append(feed, shortsTabs('feed', true));
  const s = createShorts(feed, { startId: Number(params.get('id')) || null });
  return () => s.destroy();
}

// =====================================================================
// Creator page
// =====================================================================
function renderCreator(username) {
  const page = h('div', { class: 'page' }, spinner());
  fill(main, page);
  api('/creators/' + encodeURIComponent(username))
    .then(({ creator: c, statuses }) => {
      let following = c.following;
      let followers = c.followers;
      const favBtn = h('button', { type: 'button', class: 'btn' });
      const followersEl = h('span', {});
      const paint = () => {
        favBtn.className = following ? 'btn ghost' : 'btn primary';
        fill(favBtn, icon('heart', 18), following ? t('In favorites') : t('Add to favorites'));
        favBtn.setAttribute('aria-pressed', String(following));
        followersEl.textContent = t('{n} followers', { n: fmtCount(followers) });
      };
      paint();
      favBtn.addEventListener('click', async () => {
        const now = await toggleFollow(c, following);
        if (now !== following) followers += now ? 1 : -1;
        following = now;
        paint();
      });
      const week = { from: new Date(Date.now() - 7 * 864e5), to: new Date(Date.now() + 60000) };
      const asCreator = [{ user: c, ids: statuses.map((s) => s.id), count: statuses.length, unseen: 0 }];
      const open = (statusId) => openStories({ creators: asCreator, start: 0, ...week, startStatusId: statusId, onClose: () => {} });
      const recent = statuses.filter((s) => s.createdAt > week.from.getTime());
      fill(
        page,
        h(
          'div',
          { class: 'creator-hero' },
          avatar(c, 96, { ring: recent.length ? 'new' : null }),
          h('div', {}, h('h1', { dir: 'auto' }, c.displayName, verifiedBadge(c)), h('p', { class: 'muted' }, '@' + c.username, ' · ', followersEl), c.bio ? h('p', { dir: 'auto' }, c.bio) : null),
          h('div', { class: 'creator-actions' }, c.isMe ? h('a', { class: 'btn primary', href: '#/post' }, icon('plus', 18), t('Post a short')) : favBtn, recent.length ? h('button', { type: 'button', class: 'btn ghost', onclick: () => open(null) }, icon('status', 18), t('Watch shorts')) : null),
        ),
        sectionHead(t('Shorts')),
        statuses.length
          ? h(
              'div',
              { class: 'status-grid' },
              statuses.map((s) => {
                const inner = s.kind === 'text'
                  ? h('span', { class: 'st-text', style: { background: s.bg }, dir: 'auto' }, s.body)
                  : s.kind === 'image'
                    ? h('img', { src: s.mediaUrl, alt: '', loading: 'lazy' })
                    : (() => {
                        const v = h('video', { preload: 'metadata', muted: true, playsinline: true, tabindex: '-1', 'aria-hidden': 'true' });
                        v.muted = true;
                        v.src = s.mediaUrl + '#t=0.5';
                        return v;
                      })();
                const recentEnough = s.createdAt > week.from.getTime();
                return h(
                  'button',
                  { type: 'button', class: 'st-tile', disabled: !recentEnough, onclick: () => open(s.id), 'aria-label': s.body || t('Status') },
                  inner,
                  s.kind === 'video' ? h('span', { class: 'st-kind' }, icon('play', 14)) : null,
                  h('span', { class: 'st-time' }, timeAgo(s.createdAt)),
                );
              }),
            )
          : emptyState(t('No shorts yet'), ''),
      );
    })
    .catch((err) => fill(page, emptyState(t('Creator not found'), err.message)));
}

// =====================================================================
// Post a status
// =====================================================================
function renderPost() {
  if (!state.me) return fill(main, h('div', { class: 'page narrow' }, needLogin(t('Sign in to post a short.'))));
  let file = null;
  let previewUrl = null;
  const preview = h('div', { class: 'post-preview media' });
  const caption = h('input', { class: 'input', id: 'post-caption', maxlength: '500', placeholder: t('Add a caption (optional)'), dir: 'auto' });
  const fileInput = h('input', { type: 'file', class: 'sr-only', id: 'post-file', accept: 'video/mp4,video/webm,video/quicktime' });
  const flags = {
    music: h('input', { type: 'checkbox', id: 'f-music' }),
    womenImages: h('input', { type: 'checkbox', id: 'f-wi' }),
    womenSinging: h('input', { type: 'checkbox', id: 'f-ws' }),
  };
  const submit = h('button', { type: 'submit', class: 'btn primary block' }, t('Post short'));
  const form = h('form', { class: 'post-form card' });

  function paint() {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = file ? URL.createObjectURL(file) : null;
    fill(
      preview,
      file
        ? h('video', { src: previewUrl, controls: true, playsinline: true })
        : h('div', { class: 'pick' }, icon('video', 44), h('label', { class: 'btn primary', for: 'post-file' }, icon('plus', 18), t('Choose a video')), h('p', { class: 'muted small' }, t('Vertical videos look best. Up to {mb} MB.', { mb: state.config.maxUploadMb }))),
    );
  }
  fill(
    form,
    h('h1', { class: 'page-title' }, t('Post a short')),
    preview,
    fileInput,
    h('div', { class: 'row' }, h('label', { class: 'btn ghost small', for: 'post-file', hidden: !file }, t('Change video'))),
    h('div', { class: 'field' }, h('label', { for: 'post-caption' }, t('Caption')), caption),
    h(
      'fieldset',
      { class: 'flags' },
      h('legend', {}, t('Help families filter (check all that apply)')),
      h('label', { class: 'check' }, flags.music, h('span', {}, t('Contains music'))),
      h('label', { class: 'check' }, flags.womenImages, h('span', {}, t('Shows women'))),
      h('label', { class: 'check' }, flags.womenSinging, h('span', {}, t('Women singing'))),
    ),
    state.me.verified || state.me.role === 'admin' ? null : h('p', { class: 'notice' }, icon('shield', 18), t('New creators’ shorts are reviewed by our team before they appear.')),
    submit,
  );
  fileInput.addEventListener('change', () => {
    const f = fileInput.files[0];
    fileInput.value = '';
    if (!f) return;
    if (f.size > state.config.maxUploadMb * 1024 * 1024) return toast(t('Files can be up to {mb} MB.', { mb: state.config.maxUploadMb }), true);
    file = f;
    paint();
    form.querySelector('label[for="post-file"].btn.ghost').hidden = false;
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!file) return toast(t('Choose a video to post.'), true);
    const fd = new FormData();
    fd.append('kind', 'video');
    fd.append('body', caption.value.trim());
    for (const [k, el] of Object.entries(flags)) fd.append(k, el.checked ? '1' : '0');
    fd.append('file', file);
    submit.disabled = true;
    try {
      const r = await upload('/statuses', fd, (p) => (submit.textContent = p + '%'));
      toast(r.pending ? t('Sent for review. It will appear once approved.') : t('Your short is live'));
      location.hash = '#/account';
    } catch (err) {
      toast(err.message, true);
    } finally {
      submit.disabled = false;
      submit.textContent = t('Post short');
    }
  });
  paint();
  fill(main, h('div', { class: 'page narrow' }, form));
}

// =====================================================================
// Premium
// =====================================================================
function renderPremium(params) {
  const cfg = state.config;
  const me = state.me;
  if (params.get('status') === 'success') toast(t('Welcome to Premium! It may take a moment to activate.'));
  const cta = h('div', { class: 'premium-cta' });
  if (me && me.premium) {
    cta.append(h('p', { class: 'premium-on' }, icon('check', 20), t('You’re a Premium member')));
    if (me.hasBilling && cfg.payments) {
      const manage = h('button', { type: 'button', class: 'btn ghost' }, t('Manage subscription'));
      manage.addEventListener('click', async () => {
        try {
          location.href = (await api('/premium/portal', { method: 'POST' })).url;
        } catch (err) {
          toast(err.message, true);
        }
      });
      cta.append(manage);
    }
  } else if (!me) {
    cta.append(h('a', { class: 'btn gold block', href: '#/login' }, t('Sign in to subscribe')));
  } else if (cfg.payments) {
    const buy = h('button', { type: 'button', class: 'btn gold block' }, icon('crown', 18), t('Get Premium · {price}', { price: cfg.premiumPrice }));
    buy.addEventListener('click', async () => {
      buy.disabled = true;
      try {
        location.href = (await api('/premium/checkout', { method: 'POST' })).url;
      } catch (err) {
        toast(err.message, true);
        buy.disabled = false;
      }
    });
    cta.append(buy);
  } else {
    cta.append(h('button', { type: 'button', class: 'btn gold block', disabled: true }, t('Online payments coming soon')), h('p', { class: 'muted small' }, t('Until then, the admin can turn on Premium for your account.')));
  }
  const perk = (ic, title, text) => h('li', {}, h('span', { class: 'perk-icon' }, icon(ic, 22)), h('div', {}, h('strong', {}, title), h('p', {}, text)));
  fill(
    main,
    h(
      'div',
      { class: 'page narrow' },
      h(
        'div',
        { class: 'premium card' },
        h('div', { class: 'premium-badge' }, icon('crown', 34)),
        h('h1', {}, t('{site} Premium', { site: cfg.siteName })),
        h('p', { class: 'price' }, cfg.premiumPrice),
        h(
          'ul',
          { class: 'perks' },
          perk('sparkle', t('No ads'), t('Enjoy every video and status without sponsored messages.')),
          perk('download', t('Download'), t('Save statuses, shorts and Lichtig original videos to your device.')),
          perk('heart', t('Support kosher content'), t('Your subscription helps us review content and grow the community.')),
        ),
        cta,
        h('p', { class: 'fine' }, t('YouTube videos play in YouTube’s own player. They can’t be downloaded, and YouTube may show its own ads on them.')),
      ),
    ),
  );
}

// =====================================================================
// Account (profile, language, parental controls, my statuses)
// =====================================================================
function renderAccount() {
  const me = state.me;
  if (!me) return fill(main, h('div', { class: 'page narrow' }, needLogin(t('Manage your profile, language and parental controls.'))));
  const name = h('input', { class: 'input', id: 'acc-name', value: me.displayName, maxlength: '40' });
  const bio = h('input', { class: 'input', id: 'acc-bio', value: me.bio || '', maxlength: '200', dir: 'auto' });
  const avatarInput = h('input', { type: 'file', id: 'acc-avatar', class: 'sr-only', accept: 'image/jpeg,image/png,image/webp,image/gif' });
  const avatarWrap = h('div', { class: 'acc-avatar' }, avatar(me, 84));
  avatarInput.addEventListener('change', async () => {
    const f = avatarInput.files[0];
    avatarInput.value = '';
    if (!f) return;
    const fd = new FormData();
    fd.append('file', f);
    try {
      state.me = (await upload('/me/avatar', fd)).user;
      toast(t('Photo updated'));
      route();
    } catch (err) {
      toast(err.message, true);
    }
  });
  const profile = h(
    'form',
    { class: 'card' },
    h('h2', {}, t('Profile')),
    h('div', { class: 'acc-top' }, avatarWrap, h('div', {}, h('strong', { class: 'acc-name' }, me.displayName, verifiedBadge(me)), h('p', { class: 'muted' }, '@' + me.username), h('label', { class: 'btn ghost small', for: 'acc-avatar' }, t('Change photo')), avatarInput)),
    h('div', { class: 'field' }, h('label', { for: 'acc-name' }, t('Display name')), name),
    h('div', { class: 'field' }, h('label', { for: 'acc-bio' }, t('About you')), bio),
    h('button', { type: 'submit', class: 'btn primary' }, t('Save')),
  );
  profile.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      state.me = (await api('/me', { method: 'PATCH', body: { displayName: name.value, bio: bio.value } })).user;
      toast(t('Saved'));
      renderTopbar();
    } catch (err) {
      toast(err.message, true);
    }
  });

  const langCard = h(
    'div',
    { class: 'card' },
    h('h2', {}, t('Language')),
    h(
      'div',
      { class: 'seg' },
      [['en', 'English'], ['yi', 'אידיש']].map(([code, label]) => h('button', { type: 'button', 'aria-selected': String(lang.current === code), onclick: () => switchLang(code) }, label)),
    ),
  );

  const premiumCard = h(
    'div',
    { class: 'card premium-mini' },
    h('div', {}, h('h2', {}, icon('crown', 20), ' ', t('Premium')), h('p', { class: 'muted' }, me.premium ? t('Active. No ads, and downloads are on.') : t('Remove ads and unlock downloads.'))),
    h('a', { class: 'btn ' + (me.premium ? 'ghost' : 'gold'), href: '#/premium' }, me.premium ? t('Details') : t('Go Premium')),
  );

  const parental = h('div', { class: 'card' }, spinner());
  const mine = h('div', { class: 'card' }, h('h2', {}, t('My shorts')), spinner());

  fill(
    main,
    h(
      'div',
      { class: 'page narrow account' },
      h('h1', { class: 'page-title' }, t('Account')),
      me.role === 'admin' ? h('a', { class: 'card admin-link', href: '#/admin' }, icon('settings', 22), h('div', {}, h('strong', {}, t('Admin panel')), h('p', { class: 'muted small' }, t('Videos, statuses, ads, users and settings'))), icon('next', 18)) : null,
      profile,
      langCard,
      contentPrefsCard(),
      premiumCard,
      parental,
      mine,
      h('button', { type: 'button', class: 'btn ghost danger-text', onclick: signOut }, icon('logout', 18), t('Sign out')),
    ),
  );
  renderParentalCard(parental);

  api('/me/statuses')
    .then(({ statuses }) => {
      fill(
        mine,
        h('div', { class: 'card-head' }, h('h2', {}, t('My shorts')), h('a', { class: 'btn primary small', href: '#/post' }, icon('plus', 16), t('New'))),
        statuses.length
          ? h(
              'ul',
              { class: 'my-statuses' },
              statuses.map((s) => {
                const del = h('button', { type: 'button', class: 'icon-btn ghost', 'aria-label': t('Delete') }, icon('trash', 18));
                const li = h(
                  'li',
                  {},
                  h('span', { class: 'ms-kind', style: s.kind === 'text' ? { background: s.bg } : {} }, icon(s.kind === 'video' ? 'video' : s.kind === 'image' ? 'image' : 'text', 18)),
                  h('span', { class: 'ms-body', dir: 'auto' }, s.body || (s.kind === 'image' ? t('Photo') : t('Video'))),
                  h('span', { class: 'badge-status ' + s.status }, t(s.status === 'pending' ? 'In review' : s.status === 'published' ? 'Live' : 'Not approved')),
                  h('span', { class: 'muted small' }, timeAgo(s.createdAt)),
                  del,
                );
                del.addEventListener('click', async () => {
                  if (!(await confirmSheet(t('Delete this status?'), { confirmText: t('Delete'), danger: true }))) return;
                  try {
                    await api('/statuses/' + s.id, { method: 'DELETE' });
                    li.remove();
                    toast(t('Deleted'));
                  } catch (err) {
                    toast(err.message, true);
                  }
                });
                return li;
              }),
            )
          : h('p', { class: 'muted' }, t('You haven’t posted any shorts yet.')),
      );
    })
    .catch(() => mine.remove());
}

const FILTER_LABELS = () => [
  ['kidsMode', t('Kids mode'), t('Only show videos and shorts marked for children')],
  ['hideMusic', t('Hide music'), t('Hide all songs and music videos')],
  ['autoMusicPeriods', t('No music during Sefirah and the Three Weeks'), t('Turns on automatically on those days')],
  ['hideWomenSinging', t('Always hide women singing'), t('Keeps it hidden even if someone changes the content preferences')],
  ['hideWomenImages', t('Always hide images of women'), t('Keeps it hidden even if someone changes the content preferences')],
  ['hideNews', t('Hide news'), t('Hide news videos')],
  ['hideShorts', t('Hide shorts'), t('Hide short videos from creators')],
  ['hideStatuses', t('Hide Statuses'), t('Hide the link to YidStatus.com')],
];

function contentPrefsCard() {
  const me = state.me;
  const f = state.config.filters;
  const row = (key, id, label, sub, locked) => {
    const input = h('input', { type: 'checkbox', id, checked: !!me[key] && !locked, disabled: locked });
    input.addEventListener('change', async () => {
      try {
        state.me = (await api('/me', { method: 'PATCH', body: { [key]: input.checked } })).user;
        await refreshConfig();
        toast(t('Saved'));
      } catch (err) {
        input.checked = !input.checked;
        toast(err.message, true);
      }
    });
    return h('label', { class: 'switch-row' + (locked ? ' locked' : ''), for: id }, h('span', { class: 'labels' }, h('span', { class: 'label' }, label), h('span', { class: 'sub' }, locked ? t('Locked by parental controls') : sub)), input, h('span', { class: 'sw', 'aria-hidden': 'true' }));
  };
  return h(
    'div',
    { class: 'card' },
    h('h2', {}, t('Content preferences')),
    h('p', { class: 'muted' }, t('Videos and shorts that include women are hidden unless you choose to show them.')),
    h(
      'div',
      { class: 'switch-list' },
      row('showWomenImages', 'pref-wi', t('Show videos where women appear'), t('Off by default'), f.womenImagesLocked),
      row('showWomenSinging', 'pref-ws', t('Show videos with women singing'), t('Off by default'), f.womenSingingLocked),
    ),
  );
}

async function renderParentalCard(card) {
  let info;
  try {
    info = await api('/parental');
  } catch (err) {
    return fill(card, h('p', {}, err.message));
  }
  const acc = info.account || { enabled: false };
  const enabled = acc.enabled;

  const toggles = {};
  const toggleRows = FILTER_LABELS().map(([key, label, sub]) => {
    const input = h('input', { type: 'checkbox', id: 'pc-' + key, checked: enabled ? acc[key] : ['autoMusicPeriods', 'hideWomenSinging', 'hideWomenImages'].includes(key) });
    toggles[key] = input;
    return h('label', { class: 'switch-row', for: 'pc-' + key }, h('span', { class: 'labels' }, h('span', { class: 'label' }, label), h('span', { class: 'sub' }, sub)), input, h('span', { class: 'sw', 'aria-hidden': 'true' }));
  });
  const limit = h(
    'select',
    { class: 'input', id: 'pc-limit' },
    [[0, t('No limit')], [30, t('30 minutes')], [60, t('1 hour')], [120, t('2 hours')], [180, t('3 hours')]].map(([v, l]) => h('option', { value: v, selected: Number(acc.dailyLimitMin || 0) === v }, l)),
  );
  const pin = h('input', { class: 'input', type: 'password', inputmode: 'numeric', autocomplete: 'off', maxlength: '8', id: 'pc-pin', placeholder: '••••' });
  const pin2 = h('input', { class: 'input', type: 'password', inputmode: 'numeric', autocomplete: 'off', maxlength: '8', id: 'pc-pin2', placeholder: '••••' });
  const newPin = h('input', { class: 'input', type: 'password', inputmode: 'numeric', autocomplete: 'off', maxlength: '8', id: 'pc-newpin', placeholder: t('Leave blank to keep') });
  const save = h('button', { type: 'submit', class: 'btn primary' }, enabled ? t('Save changes') : t('Turn on parental controls'));
  const off = enabled ? h('button', { type: 'button', class: 'btn ghost danger-text' }, t('Turn off')) : null;

  const form = h(
    'form',
    { class: 'parental-form' },
    h('div', { class: 'card-head' }, h('h2', {}, icon('shield', 20), ' ', t('Parental controls')), enabled ? h('span', { class: 'badge-status published' }, t('On')) : h('span', { class: 'badge-status' }, t('Off'))),
    h('p', { class: 'muted' }, enabled ? t('Changes need your PIN. These settings also stay on this device after signing out.') : t('Choose what your family sees. A PIN keeps the settings locked.')),
    h('div', { class: 'switch-list' }, toggleRows),
    h('div', { class: 'field' }, h('label', { for: 'pc-limit' }, t('Daily time limit')), limit),
    enabled
      ? [h('div', { class: 'field' }, h('label', { for: 'pc-pin' }, t('Your PIN')), pin), h('div', { class: 'field' }, h('label', { for: 'pc-newpin' }, t('New PIN (optional)')), newPin)]
      : h('div', { class: 'row two' }, h('div', { class: 'field' }, h('label', { for: 'pc-pin' }, t('Choose a PIN (4–8 digits)')), pin), h('div', { class: 'field' }, h('label', { for: 'pc-pin2' }, t('Repeat PIN')), pin2)),
    h('div', { class: 'row-end' }, off, save),
  );
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!enabled && pin.value !== pin2.value) return toast(t('The PINs don’t match.'), true);
    const settings = { dailyLimitMin: Number(limit.value) };
    for (const [k, el] of Object.entries(toggles)) settings[k] = el.checked;
    try {
      await api('/parental', { method: 'POST', body: enabled ? { pin: pin.value, newPin: newPin.value, settings } : { newPin: pin.value, settings } });
      toast(t('Parental controls saved'));
      await refreshConfig();
      route();
    } catch (err) {
      toast(err.message, true);
    }
  });
  if (off) {
    off.addEventListener('click', async () => {
      if (!pin.value) return toast(t('Enter your PIN to turn off parental controls.'), true);
      try {
        await api('/parental/disable', { method: 'POST', body: { pin: pin.value } });
        toast(t('Parental controls are off'));
        await refreshConfig();
        route();
      } catch (err) {
        toast(err.message, true);
      }
    });
  }
  const deviceNote = !enabled && info.deviceLocked ? deviceUnlock() : null;
  fill(card, deviceNote, form);
}

function deviceUnlock() {
  const pin = h('input', { class: 'input', type: 'password', inputmode: 'numeric', maxlength: '8', 'aria-label': t('PIN'), placeholder: t('PIN') });
  const btn = h('button', { type: 'button', class: 'btn ghost' }, t('Unlock this device'));
  btn.addEventListener('click', async () => {
    try {
      await api('/parental/disable', { method: 'POST', body: { pin: pin.value } });
      toast(t('Parental controls are off'));
      await refreshConfig();
      route();
    } catch (err) {
      toast(err.message, true);
    }
  });
  return h('div', { class: 'notice' }, icon('lock', 18), h('div', {}, h('strong', {}, t('This device has parental controls')), h('div', { class: 'row' }, pin, btn)));
}

async function signOut() {
  try {
    await api('/auth/logout', { method: 'POST' });
  } catch {
    /* sign out locally anyway */
  }
  state.me = null;
  await refreshConfig();
  location.hash = '#/';
}

// =====================================================================
// Sign in / sign up
// =====================================================================
function renderAuth(mode = 'login') {
  const err = h('p', { class: 'form-error', role: 'alert' });
  const user = h('input', { class: 'input', id: 'au-user', autocomplete: 'username', autocapitalize: 'none', spellcheck: 'false', maxlength: '24', required: true });
  const name = h('input', { class: 'input', id: 'au-name', autocomplete: 'name', maxlength: '40' });
  const pass = h('input', { class: 'input', id: 'au-pass', type: 'password', autocomplete: mode === 'signup' ? 'new-password' : 'current-password', required: true });
  const submit = h('button', { type: 'submit', class: 'btn primary block' }, mode === 'signup' ? t('Create account') : t('Sign in'));
  const form = h(
    'form',
    { class: 'auth-card card', novalidate: true },
    h('div', { class: 'brand big' }, logo(52), h('div', {}, h('strong', {}, state.config.siteName), h('small', {}, 'ליכטיג'))),
    h('div', { class: 'seg' }, h('a', { href: '#/login', 'aria-selected': String(mode === 'login') }, t('Sign in')), h('a', { href: '#/signup', 'aria-selected': String(mode === 'signup') }, t('Create account'))),
    h('div', { class: 'field' }, h('label', { for: 'au-user' }, t('Username')), user),
    mode === 'signup' ? h('div', { class: 'field' }, h('label', { for: 'au-name' }, t('Display name')), name) : null,
    h('div', { class: 'field' }, h('label', { for: 'au-pass' }, t('Password')), pass, mode === 'signup' ? h('small', { class: 'muted' }, t('At least 8 characters.')) : null),
    err,
    submit,
    state.config.demo ? h('p', { class: 'notice' }, icon('lock', 18), t('This is a test site. Data may be reset.')) : null,
  );
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.textContent = '';
    submit.disabled = true;
    try {
      const body = { username: user.value.trim(), password: pass.value, lang: lang.current };
      if (mode === 'signup') body.displayName = name.value.trim();
      const r = await api(mode === 'signup' ? '/auth/signup' : '/auth/login', { method: 'POST', body });
      state.me = r.user;
      if (r.user.lang && r.user.lang !== lang.current && mode === 'login') setLang(r.user.lang);
      await refreshConfig();
      location.hash = '#/';
    } catch (e2) {
      err.textContent = e2.message;
    } finally {
      submit.disabled = false;
    }
  });
  fill(main, h('div', { class: 'page auth-page' }, form));
  user.focus({ preventScroll: true });
}

// =====================================================================
// Shabbos screen & daily time limit
// =====================================================================
function renderClosed(info) {
  document.body.classList.add('closed-mode');
  const day = new Date().getDay();
  const shabbos = day === 5 || day === 6;
  fill(
    document.getElementById('app'),
    h(
      'div',
      { class: 'closed' },
      h('div', { class: 'candles', 'aria-hidden': 'true' }, h('span', { class: 'candle-stick' }, h('i')), h('span', { class: 'candle-stick' }, h('i'))),
      h('h1', {}, shabbos ? t('Gut Shabbos') : t('Gut Yom Tov')),
      h('p', { class: 'he', lang: 'he', dir: 'rtl' }, shabbos ? 'שבת שלום ומבורך' : 'גוט יום טוב'),
      h('p', {}, t('{site} is closed for Shabbos and Yom Tov.', { site: state.config?.siteName || 'Lichtig' })),
      info && info.reopensAt ? h('p', { class: 'muted' }, t('We reopen {time}.', { time: fmtTime(info.reopensAt, info.tzid || state.config?.closed?.tzid) })) : null,
    ),
  );
  if (info && info.reopensAt) setTimeout(() => location.reload(), Math.max(60000, info.reopensAt - Date.now() + 30000));
}

const USAGE_KEY = 'lt_usage';
let usageTimer = null;
function startTimeLimit() {
  clearInterval(usageTimer);
  const limit = state.config.filters.dailyLimitMin;
  if (!limit) return;
  const today = new Date().toDateString();
  const read = () => {
    try {
      const u = JSON.parse(localStorage.getItem(USAGE_KEY) || '{}');
      return u.day === today ? u : { day: today, ms: 0, unlockUntil: 0 };
    } catch {
      return { day: today, ms: 0, unlockUntil: 0 };
    }
  };
  const write = (u) => {
    try {
      localStorage.setItem(USAGE_KEY, JSON.stringify(u));
    } catch {
      /* ignore */
    }
  };
  const check = () => {
    const u = read();
    if (document.visibilityState === 'visible') u.ms += 15000;
    write(u);
    if (u.ms >= limit * 60000 && Date.now() > (u.unlockUntil || 0)) showLimitLock(u, write);
  };
  usageTimer = setInterval(check, 15000);
  const u = read();
  if (u.ms >= limit * 60000 && Date.now() > (u.unlockUntil || 0)) showLimitLock(u, write);
}

function showLimitLock(u, write) {
  if (document.querySelector('.limit-lock')) return;
  document.querySelectorAll('video').forEach((v) => v.pause());
  const pin = h('input', { class: 'input', type: 'password', inputmode: 'numeric', maxlength: '8', 'aria-label': t('PIN'), placeholder: t('Parent PIN') });
  const btn = h('button', { type: 'submit', class: 'btn primary' }, t('Unlock for 30 minutes'));
  const form = h('form', { class: 'row' }, pin, btn);
  const lock = h('div', { class: 'limit-lock', role: 'dialog', 'aria-modal': 'true' }, h('div', { class: 'limit-card' }, icon('lock', 40), h('h2', {}, t('Time’s up for today')), h('p', {}, t('You’ve reached today’s screen-time limit. Come back tomorrow!')), form));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('/parental/verify', { method: 'POST', body: { pin: pin.value } });
      u.unlockUntil = Date.now() + 30 * 60000;
      write(u);
      lock.remove();
    } catch (err) {
      toast(err.message, true);
    }
  });
  document.body.append(lock);
  pin.focus();
}

// =====================================================================
// Router
// =====================================================================
async function refreshConfig() {
  state.config = await api('/config');
  state.me = state.config.user;
  categories = (await api('/categories')).categories;
}

const ROUTES = [
  [/^\/?$/, 'home', () => renderHome()],
  [/^\/c\/([\w-]+)$/, (m) => 'c:' + m[1], (m) => renderCategory(m[1])],
  [/^\/v\/(\d+)$/, 'home', (m) => renderWatch(Number(m[1]))],
  [/^\/shorts$/, 'shorts', (m, p) => renderShorts(p)],
  [/^\/shorts\/creators$/, 'shorts', (m, p) => renderShortsCreators(p)],
  [/^\/status$/, 'status', () => renderYidStatus()],
  [/^\/search$/, 'search', (m, p) => renderSearch(p)],
  [/^\/saved$/, 'saved', () => renderSaved()],
  [/^\/u\/([^/]+)$/, 'shorts', (m) => renderCreator(decodeURIComponent(m[1]))],
  [/^\/premium$/, 'premium', (m, p) => renderPremium(p)],
  [/^\/account$/, 'account', () => renderAccount()],
  [/^\/post$/, 'shorts', () => renderPost()],
  [/^\/login$/, 'account', () => renderAuth('login')],
  [/^\/signup$/, 'account', () => renderAuth('signup')],
  [/^\/admin(?:\/(\w+))?$/, 'admin', async (m) => {
    if (!state.me || state.me.role !== 'admin') return fill(main, h('div', { class: 'page narrow' }, needLogin(t('Admins only.'))));
    const { renderAdmin } = await import('./admin.js');
    return renderAdmin(main, m[1] || 'dashboard', { categories, refresh: refreshConfig });
  }],
];

export function route() {
  if (state.config && state.config.closed && state.config.closed.closed) return renderClosed(state.config.closed);
  const raw = location.hash.replace(/^#/, '') || '/';
  const [path, qs] = raw.split('?');
  const params = new URLSearchParams(qs || '');
  [...openSheets].forEach((s) => s.close());
  if (cleanup) cleanup();
  cleanup = null;
  let match = null;
  const r = ROUTES.find(([re]) => (match = path.match(re)));
  if (!r) return location.replace('#/');
  const active = typeof r[1] === 'function' ? r[1](match) : r[1];
  document.body.dataset.route = active.split(':')[0];
  renderTopbar();
  renderSidebar(active);
  renderBottomNav(active);
  window.scrollTo(0, 0);
  main.scrollTop = 0;
  const out = r[2](match, params);
  if (typeof out === 'function') cleanup = out;
  else if (out && typeof out.then === 'function') out.then((fn) => typeof fn === 'function' && (cleanup = fn));
}

bus.on('closed', (info) => renderClosed(info));
bus.on('auth', () => {
  refreshConfig().then(route).catch(() => {});
});

async function boot() {
  try {
    await refreshConfig();
  } catch (err) {
    fill(main, emptyState(t('Could not connect'), err.message, h('button', { class: 'btn primary', onclick: () => location.reload() }, t('Try again'))));
    return;
  }
  try {
    if (state.me && state.me.lang && !localStorage.getItem('lt_lang')) setLang(state.me.lang);
  } catch {
    /* storage unavailable */
  }
  document.getElementById('skip-link')?.addEventListener('click', () => main.focus());
  window.addEventListener('hashchange', route);
  route();
  startTimeLimit();
}

boot();
