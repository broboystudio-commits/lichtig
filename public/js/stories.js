// Status viewer (WhatsApp-style stories) and the Shorts vertical feed.
import { h, fill, icon, api, t, lang, state, avatar, verifiedBadge, timeAgo, toast, openSheet, bus } from './core.js';

// ---------- seen tracking (guests keep it on the device) ----------
const SEEN_KEY = 'lt_seen';
function localSeen() {
  try {
    return new Set(JSON.parse(localStorage.getItem(SEEN_KEY) || '[]'));
  } catch {
    return new Set();
  }
}
export function isSeenLocally(id) {
  return localSeen().has(id);
}
function markSeen(id) {
  api(`/statuses/${id}/view`, { method: 'POST' }).catch(() => {});
  try {
    const s = localSeen();
    s.add(id);
    localStorage.setItem(SEEN_KEY, JSON.stringify([...s].slice(-3000)));
  } catch {
    /* storage unavailable */
  }
}

const isPremium = () => !!(state.me && state.me.premium);

export function downloadMedia(url) {
  if (!state.me) {
    toast(t('Sign in and go Premium to download.'));
    location.hash = '#/login';
    return;
  }
  if (!isPremium()) {
    toast(t('Downloading is a Premium feature.'));
    location.hash = '#/premium';
    return;
  }
  const a = h('a', { href: url + '?download=1', download: '' });
  document.body.append(a);
  a.click();
  a.remove();
}

export function reportContent(type, id) {
  const reasons = [t('Not kosher / inappropriate'), t('Women singing'), t('Spam or scam'), t('Other')];
  let picked = reasons[0];
  const list = h(
    'div',
    { class: 'radio-list', role: 'radiogroup', 'aria-label': t('Reason') },
    reasons.map((r, i) => {
      const input = h('input', { type: 'radio', name: 'reason', value: r, checked: i === 0 });
      input.addEventListener('change', () => (picked = r));
      return h('label', { class: 'radio' }, input, h('span', {}, r));
    }),
  );
  const send = h('button', { type: 'button', class: 'btn primary' }, t('Send report'));
  const sheet = openSheet({ title: t('Report this'), body: [h('p', { class: 'muted' }, t('Our team reviews every report.')), list], foot: h('div', { class: 'row-end' }, send) });
  send.addEventListener('click', async () => {
    try {
      await api('/reports', { method: 'POST', body: { type, id, reason: picked } });
      sheet.close();
      toast(t('Thank you. We will review it.'));
    } catch (err) {
      toast(err.message, true);
    }
  });
}

export async function toggleFollow(user, following) {
  if (!state.me) {
    toast(t('Sign in to add favorites.'));
    location.hash = '#/login';
    return following;
  }
  try {
    const r = await api(`/creators/${encodeURIComponent(user.username)}/follow`, { method: following ? 'DELETE' : 'POST' });
    toast(r.following ? t('Added to favorites') : t('Removed from favorites'));
    bus.emit('follow', { username: user.username, following: r.following });
    return r.following;
  } catch (err) {
    toast(err.message, true);
    return following;
  }
}

// ---------- story viewer ----------
export function openStories({ creators, start = 0, from, to, onClose, startStatusId = null }) {
  let ci = start; // creator index
  let si = 0; // status index
  let items = []; // statuses of current creator (+ ad at end)
  let raf = 0;
  let paused = false;
  let elapsed = 0;
  let last = 0;
  let duration = 6000;
  let videoEl = null;
  let closed = false;
  let followMap = new Map();

  const bars = h('div', { class: 'story-bars' });
  const headUser = h('div', { class: 'story-user' });
  const closeBtn = h('button', { type: 'button', class: 'icon-btn on-dark', 'aria-label': t('Close') }, icon('x', 22));
  const soundBtn = h('button', { type: 'button', class: 'icon-btn on-dark', 'aria-label': t('Sound') });
  const stage = h('div', { class: 'story-stage' });
  const caption = h('div', { class: 'story-caption', dir: 'auto' });
  const actions = h('div', { class: 'story-actions' });
  const prevZone = h('button', { type: 'button', class: 'story-zone prev', 'aria-label': t('Previous') });
  const nextZone = h('button', { type: 'button', class: 'story-zone next', 'aria-label': t('Next') });
  const frame = h(
    'div',
    { class: 'story', role: 'dialog', 'aria-modal': 'true', 'aria-label': t('Status') },
    stage,
    h('div', { class: 'story-top' }, bars, h('div', { class: 'story-head' }, headUser, h('div', { class: 'story-head-actions' }, soundBtn, closeBtn))),
    prevZone,
    nextZone,
    h('div', { class: 'story-bottom' }, caption, actions),
  );
  const overlay = h('div', { class: 'story-overlay' }, frame);
  document.body.append(overlay);
  document.body.classList.add('no-scroll');
  closeBtn.focus({ preventScroll: true });

  function paintSound() {
    fill(soundBtn, icon(state.muted ? 'mute' : 'volume', 20));
    soundBtn.setAttribute('aria-label', state.muted ? t('Turn sound on') : t('Turn sound off'));
    soundBtn.hidden = !videoEl;
  }
  soundBtn.addEventListener('click', () => {
    state.muted = !state.muted;
    if (videoEl) videoEl.muted = state.muted;
    paintSound();
  });

  function close() {
    if (closed) return;
    closed = true;
    cancelAnimationFrame(raf);
    if (videoEl) videoEl.pause();
    overlay.remove();
    document.body.classList.remove('no-scroll');
    document.removeEventListener('keydown', onKey, true);
    if (onClose) onClose();
  }
  closeBtn.addEventListener('click', close);

  function onKey(e) {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
    } else if (e.key === 'ArrowRight') (lang.current === 'yi' ? prev : next)();
    else if (e.key === 'ArrowLeft') (lang.current === 'yi' ? next : prev)();
    else if (e.key === ' ') {
      e.preventDefault();
      paused = !paused;
      if (videoEl) paused ? videoEl.pause() : videoEl.play().catch(() => {});
    }
  }
  document.addEventListener('keydown', onKey, true);

  // Tap zones: the "next" side follows reading direction. Press and hold pauses.
  let held = false;
  const tapGuard = (fn) => () => {
    if (held) {
      held = false;
      return;
    }
    fn();
  };
  prevZone.addEventListener('click', tapGuard(() => prev()));
  nextZone.addEventListener('click', tapGuard(() => next()));
  let holdTimer = null;
  for (const z of [prevZone, nextZone, stage]) {
    z.addEventListener('pointerdown', () => {
      held = false;
      holdTimer = setTimeout(() => {
        held = true;
        paused = true;
        if (videoEl) videoEl.pause();
      }, 220);
    });
    const release = () => {
      clearTimeout(holdTimer);
      if (held) {
        paused = false;
        if (videoEl) videoEl.play().catch(() => {});
      }
    };
    z.addEventListener('pointerup', release);
    z.addEventListener('pointerleave', release);
  }

  async function loadCreator() {
    cancelAnimationFrame(raf);
    const c = creators[ci];
    if (!c) return close();
    fill(stage, h('div', { class: 'story-loading' }, h('span', { class: 'spinner light' })));
    fill(caption);
    fill(actions);
    try {
      const res = await api(`/statuses/by/${encodeURIComponent(c.user.username)}?from=${from.toISOString()}&to=${to.toISOString()}`);
      if (closed) return;
      items = res.statuses.map((s) => ({ type: 'status', s }));
      if (res.ads && res.ads[0]) items.push({ type: 'ad', ad: res.ads[0] });
      if (!res.statuses.length) {
        ci++;
        return loadCreator();
      }
      // Start at the first unseen status, like WhatsApp.
      const firstUnseen = res.statuses.findIndex((s) => !s.seen && !isSeenLocally(s.id));
      si = firstUnseen >= 0 ? firstUnseen : 0;
      if (startStatusId) {
        const wanted = res.statuses.findIndex((s) => s.id === startStatusId);
        if (wanted >= 0) si = wanted;
        startStatusId = null;
      }
      show();
    } catch (err) {
      toast(err.message, true);
      close();
    }
  }

  function renderBars() {
    fill(
      bars,
      items.map((_, i) => h('span', { class: 'bar' }, h('span', { class: 'bar-fill', style: { width: i < si ? '100%' : '0%' } }))),
    );
  }

  function headerFor(item) {
    if (item.type === 'ad') {
      return [h('span', { class: 'ad-pill' }, t('Sponsored')), h('span', { class: 'story-name' }, item.ad.title)];
    }
    const s = item.s;
    return [
      h('a', { href: `#/u/${encodeURIComponent(s.user.username)}`, class: 'story-user-link', onclick: close }, avatar(s.user, 36)),
      h(
        'div',
        { class: 'story-meta' },
        h('span', { class: 'story-name' }, s.user.displayName, verifiedBadge(s.user)),
        h('span', { class: 'story-time' }, timeAgo(s.createdAt)),
      ),
    ];
  }

  function show() {
    cancelAnimationFrame(raf);
    if (videoEl) videoEl.pause();
    videoEl = null;
    const item = items[si];
    if (!item) return nextCreator();
    renderBars();
    fill(headUser, headerFor(item));
    elapsed = 0;
    paused = false;
    duration = 6000;

    if (item.type === 'ad') {
      api(`/ads/${item.ad.id}/impression`, { method: 'POST' }).catch(() => {});
      const media = item.ad.mime && item.ad.mime.startsWith('video/')
        ? h('video', { src: item.ad.mediaUrl, playsinline: true, autoplay: true, muted: true, class: 'story-media' })
        : h('img', { src: item.ad.mediaUrl, alt: item.ad.title, class: 'story-media' });
      fill(stage, h('a', { href: item.ad.href, target: '_blank', rel: 'noopener sponsored', class: 'story-ad-link' }, media));
      fill(caption);
      fill(
        actions,
        h('a', { class: 'btn small light', href: item.ad.href, target: '_blank', rel: 'noopener sponsored' }, t('Learn more')),
        h('a', { class: 'btn small ghost-light', href: '#/premium', onclick: close }, icon('crown', 16), t('Remove ads')),
      );
      duration = 5000;
    } else {
      const s = item.s;
      markSeen(s.id);
      if (s.kind === 'text') {
        fill(stage, h('div', { class: 'story-text', style: { background: s.bg }, dir: 'auto' }, s.body));
        duration = Math.min(12000, 4000 + s.body.length * 45);
        fill(caption);
      } else if (s.kind === 'image') {
        fill(stage, h('img', { src: s.mediaUrl, alt: s.body || t('Status photo'), class: 'story-media' }));
        fill(caption, s.body || '');
      } else {
        videoEl = h('video', { src: s.mediaUrl, playsinline: true, autoplay: true, class: 'story-media' });
        videoEl.muted = state.muted;
        videoEl.addEventListener('loadedmetadata', () => {
          duration = Math.min(60000, (videoEl.duration || 6) * 1000);
        });
        videoEl.addEventListener('ended', () => next());
        videoEl.play().catch(() => {
          // Autoplay with sound blocked: fall back to muted.
          state.muted = true;
          videoEl.muted = true;
          paintSound();
          videoEl.play().catch(() => {});
        });
        fill(stage, videoEl);
        fill(caption, s.body || '');
      }
      renderActions(s);
    }
    paintSound();
    last = performance.now();
    tick();
  }

  function renderActions(s) {
    const following = followMap.get(s.user.username.toLowerCase());
    const favBtn = h(
      'button',
      { type: 'button', class: 'pill-action', 'aria-pressed': String(!!following) },
      icon('heart', 18),
      following ? t('Favorite') : t('Add to favorites'),
    );
    favBtn.addEventListener('click', async () => {
      const now = await toggleFollow(s.user, !!followMap.get(s.user.username.toLowerCase()));
      followMap.set(s.user.username.toLowerCase(), now);
      renderActions(s);
    });
    const dl = s.kind !== 'text'
      ? h('button', { type: 'button', class: 'pill-action', onclick: () => downloadMedia(s.mediaUrl) }, icon('download', 18), isPremium() ? t('Download') : h('span', {}, t('Download'), ' ', icon('crown', 14)))
      : null;
    const rep = h('button', { type: 'button', class: 'pill-action icon-only', 'aria-label': t('Report'), onclick: () => { paused = true; reportContent('status', s.id); } }, icon('flag', 18));
    fill(actions, favBtn, dl, rep);
  }

  function tick() {
    raf = requestAnimationFrame((now) => {
      if (closed) return;
      if (!paused) {
        if (videoEl && videoEl.duration) elapsed = videoEl.currentTime * 1000;
        else elapsed += now - last;
      }
      last = now;
      const fillEl = bars.children[si] && bars.children[si].firstChild;
      if (fillEl) fillEl.style.width = Math.min(100, (elapsed / duration) * 100) + '%';
      if (elapsed >= duration && !(videoEl && !videoEl.ended && videoEl.duration)) return next();
      tick();
    });
  }

  function next() {
    if (si < items.length - 1) {
      si++;
      show();
    } else nextCreator();
  }
  function prev() {
    if (si > 0) {
      si--;
      show();
    } else if (ci > 0) {
      ci--;
      loadCreator();
    } else {
      elapsed = 0;
    }
  }
  function nextCreator() {
    ci++;
    if (ci >= creators.length) return close();
    loadCreator();
  }

  loadCreator();
  return { close };
}

// ---------- Shorts feed ----------
export function createShorts(container, { startId } = {}) {
  let slides = [];
  let loading = false;
  let done = false;
  let lastId = null;
  let ads = [];
  let current = null;
  let count = 0;
  const scroller = h('div', { class: 'shorts-scroller', 'aria-label': t('Shorts') });
  fill(container, scroller);

  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        const s = slides.find((x) => x.el === e.target);
        if (!s) continue;
        if (e.isIntersecting && e.intersectionRatio >= 0.6) {
          if (current && current !== s) current.pause();
          current = s;
          s.play();
          if (slides.indexOf(s) >= slides.length - 3) load();
        } else s.pause();
      }
    },
    { root: scroller, threshold: [0, 0.6] },
  );

  function slideFor(item) {
    const el = h('section', { class: 'short' });
    let video = null;
    if (item.type === 'ad') {
      const ad = item.ad;
      const media = ad.mime && ad.mime.startsWith('video/')
        ? (video = h('video', { src: ad.mediaUrl, playsinline: true, loop: true, muted: true, class: 'short-media' }))
        : h('img', { src: ad.mediaUrl, alt: ad.title, class: 'short-media contain' });
      el.append(
        h('a', { href: ad.href, target: '_blank', rel: 'noopener sponsored', class: 'short-ad-link' }, media),
        h('div', { class: 'short-info' }, h('span', { class: 'ad-pill' }, t('Sponsored')), h('p', { class: 'short-caption' }, ad.title),
          h('a', { class: 'btn small ghost-light', href: '#/premium' }, icon('crown', 16), t('Remove ads'))),
      );
      let counted = false;
      return {
        el,
        play() {
          if (!counted) api(`/ads/${ad.id}/impression`, { method: 'POST' }).catch(() => {});
          counted = true;
          if (video) video.play().catch(() => {});
        },
        pause() {
          if (video) video.pause();
        },
      };
    }
    const s = item.s;
    video = h('video', { src: s.mediaUrl, playsinline: true, loop: true, preload: 'metadata', class: 'short-media' });
    video.muted = true;
    const muteBtn = h('button', { type: 'button', class: 'rail-btn', 'aria-label': t('Sound') });
    const paintMute = () => {
      fill(muteBtn, icon(video.muted ? 'mute' : 'volume', 26), h('span', {}, video.muted ? t('Sound') : t('Mute')));
      muteBtn.setAttribute('aria-label', video.muted ? t('Turn sound on') : t('Turn sound off'));
    };
    muteBtn.addEventListener('click', () => {
      state.muted = !video.muted;
      video.muted = state.muted;
      paintMute();
    });
    paintMute();
    let following = false;
    const favBtn = h('button', { type: 'button', class: 'rail-btn' });
    const paintFav = () => {
      fill(favBtn, icon('heart', 26), h('span', {}, following ? t('Favorite') : t('Add')));
      favBtn.setAttribute('aria-pressed', String(following));
      favBtn.setAttribute('aria-label', following ? t('Remove from favorites') : t('Add to favorites'));
    };
    paintFav();
    favBtn.addEventListener('click', async () => {
      following = await toggleFollow(s.user, following);
      paintFav();
    });
    const tap = h('button', { type: 'button', class: 'short-tap', 'aria-label': t('Play or pause') });
    tap.addEventListener('click', () => (video.paused ? video.play().catch(() => {}) : video.pause()));
    el.append(
      video,
      tap,
      h(
        'div',
        { class: 'short-rail' },
        favBtn,
        h('button', { type: 'button', class: 'rail-btn', onclick: () => downloadMedia(s.mediaUrl), 'aria-label': t('Download') }, icon('download', 26), h('span', {}, t('Save'))),
        h('button', { type: 'button', class: 'rail-btn', onclick: () => reportContent('status', s.id), 'aria-label': t('Report') }, icon('flag', 26), h('span', {}, t('Report'))),
        muteBtn,
      ),
      h(
        'div',
        { class: 'short-info' },
        h('a', { class: 'short-user', href: `#/u/${encodeURIComponent(s.user.username)}` }, avatar(s.user, 38), h('strong', {}, s.user.displayName), verifiedBadge(s.user)),
        s.body ? h('p', { class: 'short-caption', dir: 'auto' }, s.body) : null,
        h('span', { class: 'short-time' }, timeAgo(s.createdAt)),
      ),
    );
    let viewed = false;
    return {
      el,
      play() {
        video.muted = state.muted || video.muted;
        video.play().catch(() => {
          video.muted = true;
          paintMute();
          video.play().catch(() => {});
        });
        if (!viewed) markSeen(s.id);
        viewed = true;
      },
      pause() {
        video.pause();
      },
    };
  }

  async function load() {
    if (loading || done) return;
    loading = true;
    try {
      const res = await api('/shorts' + (lastId ? `?before=${lastId}` : ''));
      ads = ads.concat(res.ads || []);
      let list = res.shorts;
      if (startId && !lastId) {
        const i = list.findIndex((x) => x.id === startId);
        if (i > 0) list = [list[i], ...list.slice(0, i), ...list.slice(i + 1)];
      }
      for (const s of list) {
        const slide = slideFor({ type: 'status', s });
        slides.push(slide);
        scroller.append(slide.el);
        io.observe(slide.el);
        count++;
        if (count % 4 === 0 && ads.length) {
          const adSlide = slideFor({ type: 'ad', ad: ads.shift() });
          slides.push(adSlide);
          scroller.append(adSlide.el);
          io.observe(adSlide.el);
        }
      }
      if (list.length) lastId = Math.min(...res.shorts.map((x) => x.id));
      done = res.done;
      if (!slides.length) {
        scroller.append(h('div', { class: 'short empty-short' }, h('div', { class: 'empty light' }, h('h3', {}, t('No shorts yet')), h('p', {}, t('Video statuses from creators show up here.')))));
      } else if (done) {
        scroller.append(h('div', { class: 'short empty-short' }, h('div', { class: 'empty light' }, h('h3', {}, t("You're all caught up")), h('a', { class: 'btn primary', href: '#/status' }, t('See all statuses')))));
      }
    } catch (err) {
      toast(err.message, true);
    } finally {
      loading = false;
    }
  }

  load();
  return {
    destroy() {
      io.disconnect();
      slides.forEach((s) => s.pause());
    },
    pause() {
      if (current) current.pause();
    },
  };
}
