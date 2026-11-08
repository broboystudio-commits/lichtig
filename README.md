# Lichtig · ליכטיג

Kosher videos, shorts and statuses for the whole family, in English and Yiddish.

## What it does

- **Videos.** A curated library of Jewish YouTube videos organized by category (Torah & Shiurim, Music, Kids, Chizuk, History, Simchas & Yom Tov, Cooking, News, Comedy). Each video shows a Lichtig-branded cover with no YouTube logo or "Watch on YouTube" until the viewer taps play. Our own "Up next" screen replaces YouTube's end-of-video suggestions. The admin can also upload original videos hosted on Lichtig.
- **Shorts.** Short vertical videos posted by the community. Viewers can swipe through the feed or browse by creator and day. Only videos can be posted, and new creators' shorts wait for admin approval.
- **Statuses.** Statuses come from **YidStatus.com**. Lichtig links to it, because YidStatus doesn't allow other sites to embed or copy its content. Kids mode and parental controls hide this section.
- **Content with women is hidden by default.** Signed-in users can choose to show videos where women appear or sing (Account → Content preferences). A parental lock always wins.
- **Parental controls (PIN-locked).** Options are Kids mode, hide music, automatically hide music during Sefirah and the Three Weeks, always hide women, hide news, hide shorts, hide Statuses, and a daily time limit. The settings stay locked on the device even after signing out.
- **Shabbos & Yom Tov mode.** The whole site closes from candle lighting to havdalah for the chosen city. The home page shows the Hebrew date and the next candle-lighting time (in that city's time zone).
- **Premium subscription.** Premium removes all ads and allows downloading shorts and Lichtig-hosted videos. It works with Stripe. Until Stripe is connected, the admin can turn on Premium by hand.
- **Kosher ads.** Only ads the admin uploads are shown, with scheduling, weighting and view and click counts. Premium members see none, and ads are never placed over YouTube videos.
- **English / Yiddish.** The switch translates the interface without flipping the layout.
- **Admin panel.** Sections cover the dashboard, adding YouTube videos by link, YouTube search, the review queue, approved channels, ads, users, reports and settings.
- **Channel auto-updates.** Paste a channel's ID link (`youtube.com/channel/UC…`) under Admin → Channels. Lichtig checks it about every 6 hours through YouTube's public feed, with no API key needed, and adds new uploads. Uploads from trusted channels go live; others wait in Review.
- **Creators & Lichtig Originals.** Users apply to become creators, and the admin approves them. Approved creators upload full-length videos and confirm they own them or have permission. Every creator video is reviewed before it goes live. Hosted videos appear under **Lichtig Originals** and on the creator's channel.
- **Import from a link.** The admin pastes a Google Drive, Dropbox or OneDrive share link (or a direct video link) that a creator sent, along with a note of who gave permission. Lichtig copies the file in the background. Links from YouTube and other video platforms are refused.
- **Filter-friendly.** Everything hosted on Lichtig, including uploads and playback, goes through Lichtig's own address. If a kosher filter allows Lichtig, these videos play even when YouTube is blocked.

## Video storage (Cloudflare R2)

Without storage connected, hosted videos are kept in the database (up to about 60 MB each, and the free database holds 1 GB in total). For full-length videos, connect Cloudflare R2, or any S3-compatible storage:

1. Create a free Cloudflare account, then open **R2** and enable it.
2. **Create bucket** named `lichtig-media` (keep it private).
3. Go to **R2 → Manage API tokens → Create API token**. Choose **Object Read & Write** for that bucket, then copy the **Access Key ID**, the **Secret Access Key** and the **S3 endpoint** (`https://<account-id>.r2.cloudflarestorage.com`).
4. On Render, open **lichtig → Environment** and add `S3_ENDPOINT`, `S3_BUCKET=lichtig-media`, `S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY`, then click **Save**.

Viewers never connect to R2 directly. Lichtig streams every file through its own `/media/…` address, with seeking supported.

## Important limits (YouTube rules)

- YouTube videos are always played through YouTube's official embedded player. They **cannot be downloaded**, and YouTube may show its own ads on some of them. Premium downloads apply to content hosted on Lichtig.
- Only add videos you have the right to show. Embedding a public YouTube video is allowed. Copying videos from other sites is not.

## Settings (environment variables)

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | Postgres connection string. Without it, an embedded database in `./data` is used. |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | Admin login. It is created or updated on every start. |
| `SESSION_SECRET` | Long random string used to sign the parental-lock cookie. |
| `YOUTUBE_API_KEY` | Optional. Turns on YouTube search, video lengths and following channels by their @name link. Channel auto-updates work without it. |
| `STRIPE_SECRET_KEY`, `STRIPE_PRICE_ID`, `STRIPE_WEBHOOK_SECRET` | Optional. Turns on Premium payments. The webhook URL is `/api/stripe/webhook`. |
| `PUBLIC_URL` | Site address used for Stripe return links (e.g. `https://lichtig.onrender.com`). |
| `MAX_UPLOAD_MB` | Largest short/photo upload (default 25). |
| `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_REGION` | Optional. Video storage (Cloudflare R2 or S3). See above. |
| `VIDEO_MAX_MB` | Largest video with storage connected (default 4096). |
| `DB_VIDEO_MAX_MB` | Largest video kept in the database without storage (default 60). |
| `STORAGE_MODE=demo` | Shows a "test site" note on the sign-in page. |

## Running locally

```bash
npm install
ADMIN_PASSWORD=choose-one npm start   # http://localhost:3000
npm test
```

Built with Node.js, Express, Postgres (or the embedded PGlite database) and plain HTML/CSS/JS. Hebrew dates and zmanim use `@hebcal/core`.
