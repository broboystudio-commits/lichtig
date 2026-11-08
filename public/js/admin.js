// Admin panel: videos, review queue, channels, ads, users, reports, settings.
import { h, fill, icon, api, upload, t, lang, catName, toast, confirmSheet, timeAgo, fmtCount, avatar, emptyState, spinner } from './core.js';

const TABS = [
  ['dashboard', 'Dashboard', 'grid'],
  ['videos', 'Videos', 'tv'],
  ['review', 'Review', 'inbox'],
  ['channels', 'Channels', 'link'],
  ['ads', 'Ads', 'megaphone'],
  ['users', 'Users', 'users'],
  ['reports', 'Reports', 'flag'],
  ['settings', 'Settings', 'settings'],
];

const FLAG_DEFS = () => [
  ['kidSafe', t('Kids')],
  ['music', t('Music')],
  ['womenSinging', t('Women singing')],
  ['womenImages', t('Shows women')],
  ['news', t('News')],
];

let ctx = { categories: [] };

export function renderAdmin(main, tab, context) {
  ctx = context;
  const body = h('div', { class: 'admin-body' }, spinner());
  fill(
    main,
    h(
      'div',
      { class: 'page admin' },
      h('div', { class: 'admin-head' }, h('h1', { class: 'page-title' }, icon('settings', 24), ' ', t('Admin')), h('a', { class: 'btn ghost small', href: '#/' }, t('View site'))),
      h('nav', { class: 'admin-tabs', 'aria-label': t('Admin sections') }, TABS.map(([key, label, ic]) => h('a', { href: '#/admin/' + key, 'aria-current': key === tab ? 'page' : null }, icon(ic, 18), h('span', {}, t(label))))),
      body,
    ),
  );
  const fn = { dashboard, videos, review, channels, ads, users, reports, settings }[tab] || dashboard;
  fn(body);
}

// ---------- helpers ----------
function categorySelect(value, { allowNone = true, id } = {}) {
  return h(
    'select',
    { class: 'input', id, 'aria-label': t('Category') },
    allowNone ? h('option', { value: '' }, t('No category')) : null,
    ctx.categories.map((c) => h('option', { value: c.slug, selected: c.slug === value }, catName(c))),
  );
}

function flagChecks(prefix, values = {}) {
  const inputs = {};
  const el = h(
    'div',
    { class: 'flag-checks' },
    FLAG_DEFS().map(([k, label]) => {
      const input = h('input', { type: 'checkbox', id: prefix + k, checked: !!values[k] });
      inputs[k] = input;
      return h('label', { class: 'check', for: prefix + k }, input, h('span', {}, label));
    }),
  );
  return { el, values: () => Object.fromEntries(Object.entries(inputs).map(([k, i]) => [k, i.checked])) };
}

function flagToggles(flags, onChange) {
  return h(
    'div',
    { class: 'flag-toggles' },
    FLAG_DEFS().map(([k, label]) => {
      const b = h('button', { type: 'button', class: 'flag-chip' + (flags[k] ? ' on' : ''), 'aria-pressed': String(!!flags[k]) }, label);
      b.addEventListener('click', async () => {
        const next = !b.classList.contains('on');
        b.classList.toggle('on', next);
        b.setAttribute('aria-pressed', String(next));
        try {
          await onChange({ ...flags, [k]: next });
          flags[k] = next;
        } catch (err) {
          b.classList.toggle('on', !next);
          toast(err.message, true);
        }
      });
      return b;
    }),
  );
}

const fmtBytes = (n) => (n > 1e9 ? (n / 1e9).toFixed(2) + ' GB' : n > 1e6 ? (n / 1e6).toFixed(1) + ' MB' : Math.round(n / 1e3) + ' KB');

function statusBadge(s) {
  return h('span', { class: 'badge-status ' + s }, t(s === 'published' ? 'Live' : s === 'pending' ? 'In review' : 'Rejected'));
}

// ---------- dashboard ----------
async function dashboard(body) {
  try {
    const { stats: s, youtubeApi, payments, storage } = await api('/admin/stats');
    const tile = (label, value, href, accent) => h('a', { class: 'stat' + (accent ? ' accent' : ''), href }, h('strong', {}, fmtCount(value)), h('span', {}, label));
    const todo = [];
    if (s.pending_statuses) todo.push(h('a', { class: 'todo', href: '#/admin/review' }, icon('inbox', 18), t('{n} shorts waiting for review', { n: s.pending_statuses })));
    if (s.pending_videos) todo.push(h('a', { class: 'todo', href: '#/admin/review' }, icon('tv', 18), t('{n} videos waiting for review', { n: s.pending_videos })));
    if (s.pending_creators) todo.push(h('a', { class: 'todo', href: '#/admin/review' }, icon('users', 18), t('{n} creator applications', { n: s.pending_creators })));
    if (s.open_reports) todo.push(h('a', { class: 'todo', href: '#/admin/reports' }, icon('flag', 18), t('{n} open reports', { n: s.open_reports })));
    fill(
      body,
      h(
        'div',
        { class: 'stats-grid' },
        tile(t('Videos live'), s.videos, '#/admin/videos'),
        tile(t('Shorts live'), s.statuses, '#/admin/review'),
        tile(t('Waiting for review'), s.pending_statuses + s.pending_videos, '#/admin/review', s.pending_statuses + s.pending_videos > 0),
        tile(t('Open reports'), s.open_reports, '#/admin/reports', s.open_reports > 0),
        tile(t('Users'), s.users, '#/admin/users'),
        tile(t('Premium members'), s.premium, '#/admin/users'),
        tile(t('Ad views'), s.ad_impressions, '#/admin/ads'),
        tile(t('Ad clicks'), s.ad_clicks, '#/admin/ads'),
      ),
      h('div', { class: 'card' }, h('h2', {}, t('To do')), todo.length ? h('div', { class: 'todo-list' }, todo) : h('p', { class: 'muted' }, t('All caught up.'))),
      h(
        'div',
        { class: 'card' },
        h('h2', {}, t('Setup')),
        h(
          'ul',
          { class: 'setup-list' },
          h('li', {}, icon(youtubeApi ? 'check' : 'x', 18), h('span', {}, youtubeApi ? t('YouTube search and channel sync are on.') : t('YouTube API key not added. You can still add videos by pasting links.'))),
          h('li', {}, icon(payments ? 'check' : 'x', 18), h('span', {}, payments ? t('Stripe payments are on.') : t('Stripe not connected yet. You can turn on Premium for users by hand.'))),
          h('li', {}, icon(storage ? 'check' : 'x', 18), h('span', {}, storage ? t('Video storage (Cloudflare R2) is connected.') : t('Video storage not connected: videos are kept in the database (up to about 60 MB each, 1 GB total).'))),
          h('li', {}, icon('check', 18), h('span', {}, t('Storage used: {size}', { size: fmtBytes(s.media_bytes) }))),
        ),
      ),
    );
  } catch (err) {
    fill(body, emptyState(t('Could not load'), err.message));
  }
}

// ---------- videos ----------
async function videos(body) {
  // Add by link
  const links = h('textarea', { class: 'input', rows: '4', id: 'yt-links', placeholder: 'https://www.youtube.com/watch?v=…\nhttps://youtu.be/…' });
  const cat = categorySelect('', { id: 'yt-cat' });
  const flags = flagChecks('yt-f-');
  const publish = h('input', { type: 'checkbox', id: 'yt-pub', checked: true });
  const addBtn = h('button', { type: 'submit', class: 'btn primary' }, icon('plus', 18), t('Add videos'));
  const results = h('div', { class: 'import-results' });
  const addForm = h(
    'form',
    { class: 'card' },
    h('h2', {}, t('Add YouTube videos')),
    h('p', { class: 'muted small' }, t('Paste one or more YouTube links. Only videos that allow embedding can be added. They play in YouTube’s own player.')),
    h('div', { class: 'field' }, h('label', { for: 'yt-links' }, t('YouTube links')), links),
    h('div', { class: 'row two' }, h('div', { class: 'field' }, h('label', { for: 'yt-cat' }, t('Category')), cat), h('label', { class: 'check', for: 'yt-pub' }, publish, h('span', {}, t('Publish right away')))),
    h('fieldset', { class: 'flags' }, h('legend', {}, t('Content tags (used by parental controls)')), flags.el),
    h('div', { class: 'row-end' }, addBtn),
    results,
  );
  addForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    addBtn.disabled = true;
    fill(results, spinner());
    try {
      const r = await api('/admin/videos/import', { method: 'POST', body: { urls: links.value, category: cat.value, flags: flags.values(), publish: publish.checked } });
      fill(results, r.results.map((x) => h('div', { class: 'import-row ' + (x.ok ? 'ok' : 'bad') }, icon(x.ok ? 'check' : 'x', 16), h('span', { class: 'mono' }, x.input), h('span', {}, x.ok ? (x.existed ? t('Already added') : t('Added')) : x.message))));
      if (r.results.some((x) => x.ok && !x.existed)) {
        links.value = '';
        loadList();
      }
    } catch (err) {
      fill(results);
      toast(err.message, true);
    } finally {
      addBtn.disabled = false;
    }
  });

  // Import a video a creator shared (Google Drive, Dropbox, OneDrive, direct link)
  const imLink = h('input', { class: 'input', id: 'im-link', placeholder: 'https://drive.google.com/file/d/…' });
  const imTitle = h('input', { class: 'input', id: 'im-title', maxlength: '200', dir: 'auto' });
  const imCat = categorySelect('', { id: 'im-cat' });
  const imCreator = h('input', { class: 'input', id: 'im-creator', placeholder: t('username (optional)') });
  const imRights = h('input', { class: 'input', id: 'im-rights', maxlength: '300', placeholder: t('e.g. Sent by Yossi Green, WhatsApp, 10 Nov') });
  const imFlags = flagChecks('im-f-');
  const imPublish = h('input', { type: 'checkbox', id: 'im-pub', checked: true });
  const imBtn = h('button', { type: 'submit', class: 'btn primary' }, icon('download', 18), t('Import video'));
  const importForm = h(
    'form',
    { class: 'card' },
    h('div', { class: 'card-head' }, h('h2', {}, t('Add a video a creator sent you')), h('a', { class: 'btn ghost small', href: '#/upload' }, icon('upload', 16), t('Upload from this computer'))),
    h('p', { class: 'muted small' }, t('Paste a Google Drive, Dropbox or OneDrive share link (or a direct video link). Lichtig copies the file and streams it from its own address, so it plays even where YouTube is filtered. Links from YouTube or other video sites are not accepted.')),
    h('div', { class: 'field' }, h('label', { for: 'im-link' }, t('Share link')), imLink),
    h('div', { class: 'row two' }, h('div', { class: 'field' }, h('label', { for: 'im-title' }, t('Title')), imTitle), h('div', { class: 'field' }, h('label', { for: 'im-cat' }, t('Category')), imCat)),
    h('div', { class: 'row two' }, h('div', { class: 'field' }, h('label', { for: 'im-rights' }, t('Who gave permission?')), imRights), h('div', { class: 'field' }, h('label', { for: 'im-creator' }, t('Show on a creator’s channel')), imCreator)),
    h('fieldset', { class: 'flags' }, h('legend', {}, t('Content tags (used by parental controls)')), imFlags.el),
    h('div', { class: 'row-end' }, h('label', { class: 'check', for: 'im-pub' }, imPublish, h('span', {}, t('Publish when ready'))), imBtn),
  );
  importForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    imBtn.disabled = true;
    try {
      await api('/admin/videos/import-link', {
        method: 'POST',
        body: { link: imLink.value.trim(), title: imTitle.value, category: imCat.value, creator: imCreator.value.trim(), rightsNote: imRights.value, flags: imFlags.values(), publish: imPublish.checked },
      });
      toast(t('Importing. It will appear when the copy finishes.'));
      importForm.reset();
      filter = 'importing';
      paintTabs();
      loadList();
    } catch (err) {
      toast(err.message, true);
    } finally {
      imBtn.disabled = false;
    }
  });

  // YouTube search (needs API key)
  const searchCard = h('div', { class: 'card' });
  api('/admin/stats').then(({ youtubeApi }) => {
    if (!youtubeApi) return searchCard.remove();
    const q = h('input', { class: 'input', placeholder: t('Search YouTube…'), 'aria-label': t('Search YouTube') });
    const out = h('div', { class: 'yt-results' });
    const f = h('form', { class: 'row' }, q, h('button', { class: 'btn ghost', type: 'submit' }, icon('search', 18), t('Search')));
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      fill(out, spinner());
      try {
        const r = await api('/admin/youtube/search?q=' + encodeURIComponent(q.value));
        fill(out, r.results.map((x) => {
          const add = h('button', { type: 'button', class: 'btn small ' + (x.added ? 'ghost' : 'primary'), disabled: x.added }, x.added ? t('Added') : t('Add'));
          add.addEventListener('click', () => {
            links.value = (links.value ? links.value + '\n' : '') + 'https://youtu.be/' + x.id;
            add.disabled = true;
            add.textContent = t('In list');
            links.scrollIntoView({ block: 'center' });
          });
          return h('div', { class: 'yt-result' }, h('img', { src: x.thumbnail, alt: '' }), h('div', {}, h('strong', { dir: 'auto' }, x.title), h('span', { class: 'muted small', dir: 'auto' }, x.channelName)), add);
        }));
      } catch (err) {
        fill(out, h('p', { class: 'muted' }, err.message));
      }
    });
    fill(searchCard, h('h2', {}, t('Search YouTube')), f, out);
  });

  // List
  let filter = 'published';
  let query = '';
  const list = h('div', { class: 'admin-list' }, spinner());
  const tabs = h('div', { class: 'pill-tabs' });
  const search = h('input', { class: 'input', type: 'search', placeholder: t('Filter by title or channel'), 'aria-label': t('Filter videos') });
  let deb = null;
  search.addEventListener('input', () => {
    clearTimeout(deb);
    deb = setTimeout(() => {
      query = search.value.trim();
      loadList();
    }, 300);
  });
  const paintTabs = () =>
    fill(tabs, [['published', 'Live'], ['pending', 'In review'], ['importing', 'Importing'], ['rejected', 'Rejected']].map(([k, label]) => {
      const b = h('button', { type: 'button', class: 'pill' + (filter === k ? ' on' : '') }, t(label));
      b.addEventListener('click', () => {
        filter = k;
        paintTabs();
        loadList();
      });
      return b;
    }));
  paintTabs();

  let refreshTimer = null;
  async function loadList() {
    fill(list, spinner());
    try {
      const r = await api(`/admin/videos?status=${filter}&q=${encodeURIComponent(query)}`);
      clearTimeout(refreshTimer);
      if (filter === 'importing' && r.videos.some((v) => v.status === 'processing') && list.isConnected) {
        refreshTimer = setTimeout(loadList, 5000);
      }
      if (!r.videos.length) return fill(list, emptyState(t('No videos'), ''));
      fill(list, r.videos.map(videoRow));
    } catch (err) {
      fill(list, emptyState(t('Could not load'), err.message));
    }
  }

  function videoRow(v) {
    const patch = (body) => api('/admin/videos/' + v.id, { method: 'PATCH', body });
    const catSel = categorySelect(v.category);
    catSel.addEventListener('change', () => patch({ category: catSel.value }).then(() => toast(t('Saved'))).catch((e) => toast(e.message, true)));
    const feat = h('button', { type: 'button', class: 'flag-chip gold' + (v.featured ? ' on' : ''), 'aria-pressed': String(v.featured) }, t('Featured'));
    feat.addEventListener('click', async () => {
      try {
        await patch({ featured: !v.featured });
        v.featured = !v.featured;
        feat.classList.toggle('on', v.featured);
        feat.setAttribute('aria-pressed', String(v.featured));
      } catch (e) {
        toast(e.message, true);
      }
    });
    const row = h('div', { class: 'admin-row' });
    const actions = h('div', { class: 'row-actions' });
    const setStatus = async (s) => {
      try {
        await patch({ status: s });
        toast(s === 'published' ? t('Published') : t('Moved'));
        row.remove();
      } catch (e) {
        toast(e.message, true);
      }
    };
    if (v.status !== 'published') actions.append(h('button', { type: 'button', class: 'btn small primary', onclick: () => setStatus('published') }, t('Publish')));
    if (v.status !== 'rejected') actions.append(h('button', { type: 'button', class: 'btn small ghost', onclick: () => setStatus('rejected') }, v.status === 'published' ? t('Unpublish') : t('Reject')));
    const del = h('button', { type: 'button', class: 'icon-btn ghost', 'aria-label': t('Delete') }, icon('trash', 18));
    del.addEventListener('click', async () => {
      if (!(await confirmSheet(t('Delete “{title}”?', { title: v.title }), { confirmText: t('Delete'), danger: true }))) return;
      try {
        await api('/admin/videos/' + v.id, { method: 'DELETE' });
        row.remove();
      } catch (e) {
        toast(e.message, true);
      }
    });
    actions.append(del);
    fill(
      row,
      h('a', { class: 'admin-thumb', href: '#/v/' + v.id }, v.thumbnail ? h('img', { src: v.thumbnail, alt: '', loading: 'lazy' }) : icon('tv', 26)),
      h(
        'div',
        { class: 'admin-row-main' },
        h('a', { class: 'admin-row-title', href: '#/v/' + v.id, dir: 'auto' }, v.title),
        h('span', { class: 'muted small', dir: 'auto' }, [v.channelName, v.creator ? '@' + v.creator : null, v.source === 'upload' ? t('Hosted on Lichtig') : 'YouTube', t('{n} views', { n: fmtCount(v.views) })].filter(Boolean).join(' · ')),
        v.status === 'processing' ? h('span', { class: 'badge-status pending' }, h('span', { class: 'spinner tiny' }), ' ', t('Copying the file…')) : null,
        v.status === 'failed' ? h('span', { class: 'badge-status rejected' }, t('Import failed: {why}', { why: v.importError })) : null,
        v.rightsNote ? h('span', { class: 'rights-note' }, icon('shield', 14), v.rightsNote) : null,
        h('div', { class: 'row wrap' }, catSel, feat),
        flagToggles({ ...v.flags }, (f) => patch({ flags: f })),
      ),
      actions,
    );
    return row;
  }

  fill(body, importForm, addForm, searchCard, h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', {}, t('All videos')), tabs), search, list));
  loadList();
}

// ---------- review queue ----------
async function review(body) {
  const statusesBox = h('div', { class: 'review-grid' }, spinner());
  const videosBox = h('div', { class: 'admin-list' }, spinner());
  const creatorsBox = h('div', { class: 'admin-list' }, spinner());
  fill(body, h('div', { class: 'card' }, h('h2', {}, t('Creator applications')), creatorsBox), h('div', { class: 'card' }, h('h2', {}, t('Shorts waiting for review')), statusesBox), h('div', { class: 'card' }, h('h2', {}, t('Videos waiting for review')), h('p', { class: 'muted small' }, t('Creator uploads, and new uploads from synced channels that aren’t trusted, wait here.')), videosBox));

  api('/admin/creators?status=pending')
    .then(({ creators }) => {
      if (!creators.length) return fill(creatorsBox, h('p', { class: 'muted' }, t('No applications waiting.')));
      fill(
        creatorsBox,
        creators.map((c) => {
          const row = h('div', { class: 'admin-row' });
          const decide = async (status) => {
            try {
              await api('/admin/creators/' + c.id, { method: 'PATCH', body: { status } });
              toast(status === 'approved' ? t('Creator approved') : t('Application declined'));
              row.remove();
            } catch (e) {
              toast(e.message, true);
            }
          };
          fill(
            row,
            avatar(c, 44),
            h('div', { class: 'admin-row-main' }, h('strong', { dir: 'auto' }, c.channel || c.displayName), h('span', { class: 'muted small' }, '@' + c.username + (c.contact ? ' · ' + c.contact : '')), c.about ? h('p', { class: 'small', dir: 'auto' }, c.about) : null),
            h('div', { class: 'row-actions' }, h('button', { type: 'button', class: 'btn small primary', onclick: () => decide('approved') }, icon('check', 16), t('Approve')), h('button', { type: 'button', class: 'btn small ghost', onclick: () => decide('declined') }, t('Decline'))),
          );
          return row;
        }),
      );
    })
    .catch((err) => fill(creatorsBox, h('p', { class: 'muted' }, err.message)));

  try {
    const { statuses } = await api('/admin/statuses?status=pending');
    if (!statuses.length) fill(statusesBox, h('p', { class: 'muted' }, t('No shorts waiting.')));
    else
      fill(
        statusesBox,
        statuses.map((s) => {
          const card = h('div', { class: 'review-card' });
          const flags = { ...s.flags };
          const decide = async (status, verifyCreator = false) => {
            try {
              await api('/admin/statuses/' + s.id, { method: 'PATCH', body: { status, flags, verifyCreator } });
              toast(status === 'published' ? t('Approved') : t('Rejected'));
              card.remove();
            } catch (e) {
              toast(e.message, true);
            }
          };
          const preview = s.kind === 'text'
            ? h('div', { class: 'rv-text', style: { background: s.bg }, dir: 'auto' }, s.body)
            : s.kind === 'image'
              ? h('img', { src: s.mediaUrl, alt: '' })
              : h('video', { src: s.mediaUrl, controls: true, playsinline: true, preload: 'metadata' });
          fill(
            card,
            h('div', { class: 'rv-preview' }, preview),
            h('div', { class: 'rv-user' }, avatar(s.user, 28), h('strong', {}, s.user.displayName), h('span', { class: 'muted small' }, '@' + s.user.username + ' · ' + timeAgo(s.createdAt))),
            s.kind !== 'text' && s.body ? h('p', { dir: 'auto' }, s.body) : null,
            h('div', { class: 'flag-toggles' }, [['kidSafe', t('Kids')], ['music', t('Music')], ['womenSinging', t('Women singing')], ['womenImages', t('Shows women')]].map(([k, label]) => {
              const b = h('button', { type: 'button', class: 'flag-chip' + (flags[k] ? ' on' : ''), 'aria-pressed': String(!!flags[k]) }, label);
              b.addEventListener('click', () => {
                flags[k] = !flags[k];
                b.classList.toggle('on', flags[k]);
                b.setAttribute('aria-pressed', String(flags[k]));
              });
              return b;
            })),
            h(
              'div',
              { class: 'row wrap' },
              h('button', { type: 'button', class: 'btn small primary', onclick: () => decide('published') }, icon('check', 16), t('Approve')),
              s.user.verified ? null : h('button', { type: 'button', class: 'btn small ghost', onclick: () => decide('published', true), title: t('Future shorts from this creator go live without review') }, t('Approve & trust creator')),
              h('button', { type: 'button', class: 'btn small danger', onclick: () => decide('rejected') }, t('Reject')),
            ),
          );
          return card;
        }),
      );
  } catch (err) {
    fill(statusesBox, h('p', { class: 'muted' }, err.message));
  }

  try {
    const { videos: list } = await api('/admin/videos?status=pending');
    if (!list.length) fill(videosBox, h('p', { class: 'muted' }, t('No videos waiting.')));
    else
      fill(
        videosBox,
        list.map((v) => {
          const row = h('div', { class: 'admin-row' });
          const decide = async (status) => {
            try {
              await api('/admin/videos/' + v.id, { method: 'PATCH', body: { status } });
              row.remove();
            } catch (e) {
              toast(e.message, true);
            }
          };
          fill(
            row,
            h('a', { class: 'admin-thumb', href: '#/v/' + v.id }, v.thumbnail ? h('img', { src: v.thumbnail, alt: '' }) : icon('tv', 24)),
            h('div', { class: 'admin-row-main' }, h('a', { class: 'admin-row-title', href: '#/v/' + v.id, dir: 'auto' }, v.title), h('span', { class: 'muted small' }, [v.channelName, v.creator ? '@' + v.creator : null].filter(Boolean).join(' · ')), v.rightsNote ? h('span', { class: 'rights-note' }, icon('shield', 14), v.rightsNote) : null, flagToggles({ ...v.flags }, (f) => api('/admin/videos/' + v.id, { method: 'PATCH', body: { flags: f } }))),
            h('div', { class: 'row-actions' }, h('button', { type: 'button', class: 'btn small primary', onclick: () => decide('published') }, t('Publish')), h('button', { type: 'button', class: 'btn small ghost', onclick: () => decide('rejected') }, t('Reject'))),
          );
          return row;
        }),
      );
  } catch (err) {
    fill(videosBox, h('p', { class: 'muted' }, err.message));
  }
}

// ---------- channels ----------
async function channels(body) {
  const url = h('input', { class: 'input', id: 'ch-url', placeholder: 'https://www.youtube.com/@ChannelName' });
  const cat = categorySelect('', { id: 'ch-cat' });
  const trusted = h('input', { type: 'checkbox', id: 'ch-trusted' });
  const add = h('button', { type: 'submit', class: 'btn primary' }, icon('plus', 18), t('Add channel'));
  const form = h(
    'form',
    { class: 'card' },
    h('h2', {}, t('Approved channels')),
    h('p', { class: 'muted small' }, t('With a YouTube API key, Lichtig checks these channels every 6 hours and adds new uploads. Uploads from trusted channels go live right away; others wait in Review.')),
    h('div', { class: 'field' }, h('label', { for: 'ch-url' }, t('Channel link')), url),
    h('div', { class: 'row two' }, h('div', { class: 'field' }, h('label', { for: 'ch-cat' }, t('Default category')), cat), h('label', { class: 'check', for: 'ch-trusted' }, trusted, h('span', {}, t('Trusted (publish new uploads automatically)')))),
    h('div', { class: 'row-end' }, add),
  );
  const list = h('div', { class: 'admin-list' }, spinner());
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    add.disabled = true;
    try {
      const r = await api('/admin/channels', { method: 'POST', body: { url: url.value.trim(), category: cat.value, trusted: trusted.checked } });
      toast(r.sync && r.sync.added !== undefined ? t('Channel added. {n} new videos found.', { n: r.sync.added }) : t('Channel added'));
      form.reset();
      load();
    } catch (err) {
      toast(err.message, true);
    } finally {
      add.disabled = false;
    }
  });
  async function load() {
    try {
      const { channels: chs } = await api('/admin/channels');
      if (!chs.length) return fill(list, h('p', { class: 'muted' }, t('No channels yet.')));
      fill(
        list,
        chs.map((c) => {
          const row = h('div', { class: 'admin-row' });
          const tr = h('button', { type: 'button', class: 'flag-chip' + (c.trusted ? ' on' : ''), 'aria-pressed': String(c.trusted) }, t('Trusted'));
          tr.addEventListener('click', async () => {
            try {
              await api('/admin/channels/' + c.id, { method: 'PATCH', body: { trusted: !c.trusted } });
              c.trusted = !c.trusted;
              tr.classList.toggle('on', c.trusted);
              tr.setAttribute('aria-pressed', String(c.trusted));
            } catch (e) {
              toast(e.message, true);
            }
          });
          const sync = h('button', { type: 'button', class: 'btn small ghost' }, icon('refresh', 16), t('Check now'));
          sync.addEventListener('click', async () => {
            sync.disabled = true;
            try {
              const r = await api(`/admin/channels/${c.id}/sync`, { method: 'POST' });
              toast(t('{n} new videos found', { n: r.added }));
              load();
            } catch (e) {
              toast(e.message, true);
            } finally {
              sync.disabled = false;
            }
          });
          const del = h('button', { type: 'button', class: 'icon-btn ghost', 'aria-label': t('Remove') }, icon('trash', 18));
          del.addEventListener('click', async () => {
            if (!(await confirmSheet(t('Remove this channel? Its videos stay on the site.'), { confirmText: t('Remove'), danger: true }))) return;
            await api('/admin/channels/' + c.id, { method: 'DELETE' }).catch((e) => toast(e.message, true));
            row.remove();
          });
          fill(
            row,
            h('span', { class: 'admin-thumb round' }, c.thumbnail ? h('img', { src: c.thumbnail, alt: '' }) : icon('tv', 22)),
            h('div', { class: 'admin-row-main' }, h('a', { class: 'admin-row-title', href: c.url, target: '_blank', rel: 'noopener', dir: 'auto' }, c.name), h('span', { class: 'muted small' }, [t('{n} videos', { n: c.videoCount }), c.lastSyncedAt ? t('checked {time}', { time: timeAgo(c.lastSyncedAt) }) : null].filter(Boolean).join(' · '))),
            h('div', { class: 'row-actions' }, tr, sync, del),
          );
          return row;
        }),
      );
    } catch (err) {
      fill(list, h('p', { class: 'muted' }, err.message));
    }
  }
  fill(body, form, h('div', { class: 'card' }, list));
  load();
}

// ---------- ads ----------
async function ads(body) {
  const file = h('input', { type: 'file', id: 'ad-file', class: 'input', accept: 'image/jpeg,image/png,image/webp,image/gif,video/mp4' });
  const title = h('input', { class: 'input', id: 'ad-title', maxlength: '120', dir: 'auto' });
  const link = h('input', { class: 'input', id: 'ad-link', placeholder: 'https://' });
  const placement = h('select', { class: 'input', id: 'ad-place' }, [['banner', t('Banner (home page)')], ['watch', t('Under the video player')], ['status', t('Between shorts (full screen)')]].map(([v, l]) => h('option', { value: v }, l)));
  const starts = h('input', { class: 'input', type: 'date', id: 'ad-start' });
  const ends = h('input', { class: 'input', type: 'date', id: 'ad-end' });
  const weight = h('input', { class: 'input', type: 'number', min: '1', max: '10', value: '1', id: 'ad-weight' });
  const save = h('button', { type: 'submit', class: 'btn primary' }, icon('plus', 18), t('Add ad'));
  const form = h(
    'form',
    { class: 'card' },
    h('h2', {}, t('Add a kosher ad')),
    h('p', { class: 'muted small' }, t('Only ads you add here are ever shown. Premium members never see ads. Ads are never placed over YouTube videos.')),
    h('div', { class: 'row two' }, h('div', { class: 'field' }, h('label', { for: 'ad-title' }, t('Ad name')), title), h('div', { class: 'field' }, h('label', { for: 'ad-link' }, t('Link (where it goes when tapped)')), link)),
    h('div', { class: 'row two' }, h('div', { class: 'field' }, h('label', { for: 'ad-file' }, t('Image or video')), file, h('small', { class: 'muted' }, t('Banner: wide image (about 1200×240). Shorts: tall image (about 1080×1920).'))), h('div', { class: 'field' }, h('label', { for: 'ad-place' }, t('Where to show it')), placement)),
    h('div', { class: 'row three' }, h('div', { class: 'field' }, h('label', { for: 'ad-start' }, t('Start date (optional)')), starts), h('div', { class: 'field' }, h('label', { for: 'ad-end' }, t('End date (optional)')), ends), h('div', { class: 'field' }, h('label', { for: 'ad-weight' }, t('How often (1–10)')), weight)),
    h('div', { class: 'row-end' }, save),
  );
  const list = h('div', { class: 'ads-list' }, spinner());
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!file.files[0]) return toast(t('Choose an image or video for the ad.'), true);
    const fd = new FormData();
    fd.append('title', title.value);
    fd.append('link', link.value);
    fd.append('placement', placement.value);
    if (starts.value) fd.append('startsAt', starts.value + 'T00:00:00');
    if (ends.value) fd.append('endsAt', ends.value + 'T23:59:59');
    fd.append('weight', weight.value);
    fd.append('file', file.files[0]);
    save.disabled = true;
    try {
      await upload('/admin/ads', fd, (p) => (save.textContent = p + '%'));
      toast(t('Ad added'));
      form.reset();
      load();
    } catch (err) {
      toast(err.message, true);
    } finally {
      save.disabled = false;
      save.textContent = t('Add ad');
    }
  });
  const placeLabel = { banner: t('Banner'), watch: t('Under player'), status: t('Shorts') };
  async function load() {
    try {
      const { ads: list2 } = await api('/admin/ads');
      if (!list2.length) return fill(list, h('p', { class: 'muted' }, t('No ads yet.')));
      fill(
        list,
        list2.map((a) => {
          const card = h('div', { class: 'ad-card' + (a.active ? '' : ' off') });
          const active = h('button', { type: 'button', class: 'flag-chip' + (a.active ? ' on' : ''), 'aria-pressed': String(a.active) }, a.active ? t('Active') : t('Paused'));
          active.addEventListener('click', async () => {
            try {
              await api('/admin/ads/' + a.id, { method: 'PATCH', body: { active: !a.active } });
              a.active = !a.active;
              active.classList.toggle('on', a.active);
              active.textContent = a.active ? t('Active') : t('Paused');
              card.classList.toggle('off', !a.active);
            } catch (e) {
              toast(e.message, true);
            }
          });
          const del = h('button', { type: 'button', class: 'icon-btn ghost', 'aria-label': t('Delete') }, icon('trash', 18));
          del.addEventListener('click', async () => {
            if (!(await confirmSheet(t('Delete this ad?'), { confirmText: t('Delete'), danger: true }))) return;
            await api('/admin/ads/' + a.id, { method: 'DELETE' }).catch((e) => toast(e.message, true));
            card.remove();
          });
          const ctr = a.impressions ? ((a.clicks / a.impressions) * 100).toFixed(1) + '%' : '–';
          const dates = [a.startsAt ? new Date(a.startsAt).toLocaleDateString() : null, a.endsAt ? new Date(a.endsAt).toLocaleDateString() : null];
          fill(
            card,
            h('div', { class: 'ad-prev ' + a.placement }, a.mime && a.mime.startsWith('video/') ? h('video', { src: a.mediaUrl, muted: true, playsinline: true, preload: 'metadata' }) : h('img', { src: a.mediaUrl, alt: '' })),
            h(
              'div',
              { class: 'ad-info' },
              h('strong', { dir: 'auto' }, a.title),
              h('span', { class: 'muted small' }, placeLabel[a.placement] + (a.link ? ' · ' + a.link : '')),
              h('span', { class: 'muted small' }, t('{v} views · {c} clicks · {r} click rate', { v: fmtCount(a.impressions), c: fmtCount(a.clicks), r: ctr })),
              dates[0] || dates[1] ? h('span', { class: 'muted small' }, (dates[0] || '…') + ' → ' + (dates[1] || '…')) : null,
              h('div', { class: 'row' }, active, del),
            ),
          );
          return card;
        }),
      );
    } catch (err) {
      fill(list, h('p', { class: 'muted' }, err.message));
    }
  }
  fill(body, form, h('div', { class: 'card' }, h('h2', {}, t('Your ads')), list));
  load();
}

// ---------- users ----------
async function users(body) {
  const q = h('input', { class: 'input', type: 'search', placeholder: t('Search users'), 'aria-label': t('Search users') });
  const list = h('div', { class: 'admin-list' }, spinner());
  let deb = null;
  q.addEventListener('input', () => {
    clearTimeout(deb);
    deb = setTimeout(load, 300);
  });
  async function load() {
    try {
      const r = await api('/admin/users?q=' + encodeURIComponent(q.value.trim()));
      fill(
        list,
        r.users.map((u) => {
          const toggle = (key, label, value) => {
            const b = h('button', { type: 'button', class: 'flag-chip' + (value ? ' on' : '') + (key === 'banned' ? ' danger' : ''), 'aria-pressed': String(!!value) }, label);
            b.addEventListener('click', async () => {
              const next = !(b.getAttribute('aria-pressed') === 'true');
              const body2 = key === 'role' ? { role: next ? 'admin' : 'user' } : key === 'creatorStatus' ? { creatorStatus: next ? 'approved' : 'none' } : { [key]: next };
              try {
                await api('/admin/users/' + u.id, { method: 'PATCH', body: body2 });
                b.classList.toggle('on', next);
                b.setAttribute('aria-pressed', String(next));
              } catch (e) {
                toast(e.message, true);
              }
            });
            return b;
          };
          return h(
            'div',
            { class: 'admin-row' },
            avatar(u, 40),
            h('div', { class: 'admin-row-main' }, h('a', { class: 'admin-row-title', href: '#/u/' + encodeURIComponent(u.username) }, u.displayName), h('span', { class: 'muted small' }, '@' + u.username + ' · ' + t('joined {time}', { time: timeAgo(u.createdAt) }) + ' · ' + t('{n} shorts', { n: u.statusCount }))),
            h('div', { class: 'row-actions wrap' }, toggle('creatorStatus', t('Video creator'), u.creatorStatus === 'approved'), toggle('verified', t('Trusted (shorts)'), u.verified), toggle('premium', t('Premium'), u.premium), toggle('role', t('Admin'), u.role === 'admin'), toggle('banned', t('Banned'), u.banned)),
          );
        }),
      );
    } catch (err) {
      fill(list, h('p', { class: 'muted' }, err.message));
    }
  }
  fill(body, h('div', { class: 'card' }, h('h2', {}, t('Users')), h('p', { class: 'muted small' }, t('Trusted creators’ shorts go live without review. Premium removes ads and allows downloads.')), q, list));
  load();
}

// ---------- reports ----------
async function reports(body) {
  const list = h('div', { class: 'admin-list' }, spinner());
  fill(body, h('div', { class: 'card' }, h('h2', {}, t('Open reports')), list));
  try {
    const r = await api('/admin/reports');
    if (!r.reports.length) return fill(list, h('p', { class: 'muted' }, t('No open reports.')));
    fill(
      list,
      r.reports.map((x) => {
        const row = h('div', { class: 'admin-row' });
        const resolve = h('button', { type: 'button', class: 'btn small ghost' }, icon('check', 16), t('Resolved'));
        resolve.addEventListener('click', async () => {
          await api('/admin/reports/' + x.id, { method: 'PATCH' }).catch((e) => toast(e.message, true));
          row.remove();
        });
        const removeBtn = h('button', { type: 'button', class: 'btn small danger' }, t('Remove content'));
        removeBtn.addEventListener('click', async () => {
          if (!(await confirmSheet(t('Remove this content from the site?'), { confirmText: t('Remove'), danger: true }))) return;
          try {
            if (x.type === 'video') await api('/admin/videos/' + x.targetId, { method: 'PATCH', body: { status: 'rejected' } });
            else await api('/admin/statuses/' + x.targetId, { method: 'PATCH', body: { status: 'rejected' } });
            await api('/admin/reports/' + x.id, { method: 'PATCH' });
            row.remove();
            toast(t('Removed'));
          } catch (e) {
            toast(e.message, true);
          }
        });
        fill(
          row,
          h('span', { class: 'admin-thumb round' }, icon(x.type === 'video' ? 'tv' : 'status', 22)),
          h('div', { class: 'admin-row-main' }, x.type === 'video' ? h('a', { class: 'admin-row-title', href: '#/v/' + x.targetId, dir: 'auto' }, x.targetLabel) : h('span', { class: 'admin-row-title', dir: 'auto' }, x.targetLabel), h('span', { class: 'muted small' }, `${x.reason || t('No reason given')} · ${x.reporter ? '@' + x.reporter : t('guest')} · ${timeAgo(x.createdAt)}`)),
          h('div', { class: 'row-actions' }, removeBtn, resolve),
        );
        return row;
      }),
    );
  } catch (err) {
    fill(list, h('p', { class: 'muted' }, err.message));
  }
}

// ---------- settings ----------
async function settings(body) {
  try {
    const { settings: s, cities } = await api('/admin/settings');
    const { youtubeApi, payments, storage } = await api('/admin/stats');
    const siteName = h('input', { class: 'input', id: 'st-name', value: s.siteName, maxlength: '40' });
    const announce = h('input', { class: 'input', id: 'st-ann', value: s.announcement || '', maxlength: '240', dir: 'auto', placeholder: t('Shown at the top of the home page') });
    const price = h('input', { class: 'input', id: 'st-price', value: s.premiumPrice, maxlength: '40' });
    const shab = h('input', { type: 'checkbox', id: 'st-shab', checked: !!s.shabbos.enabled });
    const city = h('select', { class: 'input', id: 'st-city' }, cities.map((c) => h('option', { value: c, selected: c === s.shabbos.city }, c)));
    const music = h('input', { type: 'checkbox', id: 'st-music', checked: !!s.musicPeriods });
    const save = h('button', { type: 'submit', class: 'btn primary' }, t('Save settings'));
    const form = h(
      'form',
      { class: 'card' },
      h('h2', {}, t('Site')),
      h('div', { class: 'row two' }, h('div', { class: 'field' }, h('label', { for: 'st-name' }, t('Site name')), siteName), h('div', { class: 'field' }, h('label', { for: 'st-price' }, t('Premium price (shown to users)')), price)),
      h('div', { class: 'field' }, h('label', { for: 'st-ann' }, t('Announcement')), announce),
      h('h2', {}, t('Shabbos & Yom Tov')),
      h('label', { class: 'switch-row', for: 'st-shab' }, h('span', { class: 'labels' }, h('span', { class: 'label' }, t('Close the site for Shabbos and Yom Tov')), h('span', { class: 'sub' }, t('From candle lighting until havdalah, everyone sees a “Gut Shabbos” page.'))), shab, h('span', { class: 'sw', 'aria-hidden': 'true' })),
      h('div', { class: 'field' }, h('label', { for: 'st-city' }, t('Zmanim city')), city),
      h('label', { class: 'switch-row', for: 'st-music' }, h('span', { class: 'labels' }, h('span', { class: 'label' }, t('No music site-wide during Sefirah and the Three Weeks')), h('span', { class: 'sub' }, t('Hides videos and statuses tagged “Music” on those days (except Lag BaOmer).'))), music, h('span', { class: 'sw', 'aria-hidden': 'true' })),
      h('div', { class: 'row-end' }, save),
    );
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      save.disabled = true;
      try {
        await api('/admin/settings', { method: 'PATCH', body: { siteName: siteName.value, announcement: announce.value, premiumPrice: price.value, musicPeriods: music.checked, shabbos: { enabled: shab.checked, city: city.value } } });
        toast(t('Settings saved'));
        await ctx.refresh();
      } catch (err) {
        toast(err.message, true);
      } finally {
        save.disabled = false;
      }
    });
    const cat = h('input', { class: 'input', id: 'cat-en', maxlength: '40', placeholder: t('English name') });
    const catYi = h('input', { class: 'input', id: 'cat-yi', maxlength: '40', placeholder: t('Yiddish name'), dir: 'rtl' });
    const catForm = h('form', { class: 'card' }, h('h2', {}, t('Categories')), h('div', { class: 'chips static' }, ctx.categories.map((c) => h('span', { class: 'chip' }, catName(c)))), h('div', { class: 'row' }, cat, catYi, h('button', { class: 'btn ghost', type: 'submit' }, icon('plus', 18), t('Add'))));
    catForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        await api('/admin/categories', { method: 'POST', body: { nameEn: cat.value, nameYi: catYi.value } });
        toast(t('Category added'));
        await ctx.refresh();
        location.reload();
      } catch (err) {
        toast(err.message, true);
      }
    });
    const integ = h(
      'div',
      { class: 'card' },
      h('h2', {}, t('Connections')),
      h('ul', { class: 'setup-list' },
        h('li', {}, icon(youtubeApi ? 'check' : 'x', 18), h('div', {}, h('strong', {}, 'YouTube API'), h('p', { class: 'muted small' }, youtubeApi ? t('Connected: search and automatic channel updates are on.') : t('Optional. Add YOUTUBE_API_KEY on Render to search YouTube from here and auto-add new uploads from approved channels.')))),
        h('li', {}, icon(storage ? 'check' : 'x', 18), h('div', {}, h('strong', {}, t('Video storage (Cloudflare R2)')), h('p', { class: 'muted small' }, storage ? t('Connected: large videos are stored in R2 and stream from Lichtig’s address.') : t('Add S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY on Render to store full-length videos.')))),
        h('li', {}, icon(payments ? 'check' : 'x', 18), h('div', {}, h('strong', {}, 'Stripe'), h('p', { class: 'muted small' }, payments ? t('Connected: members can subscribe to Premium online.') : t('Add STRIPE_SECRET_KEY, STRIPE_PRICE_ID and STRIPE_WEBHOOK_SECRET on Render to take Premium payments.'))))),
    );
    fill(body, form, catForm, integ);
  } catch (err) {
    fill(body, emptyState(t('Could not load'), err.message));
  }
}

export const _lang = lang;
