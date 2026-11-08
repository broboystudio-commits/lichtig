# Lichtig · ליכטיג

Kosher videos, shorts and statuses for the whole family, in English and Yiddish.

## What it does

- **Videos.** A curated library of Jewish YouTube videos organized by category (Torah & Shiurim, Music, Kids, Chizuk, History, Simchas & Yom Tov, Cooking, News, Comedy). They play in YouTube's own embedded player. The admin can also upload original videos hosted on Lichtig.
- **Statuses.** WhatsApp-style statuses from creators, browsable by day. They open in a full-screen viewer.
- **Shorts.** A vertical feed made from video statuses.
- **Kosher moderation.** New creators' statuses wait for admin approval, trusted creators publish directly, and viewers can report anything.
- **Parental controls (PIN-locked).** Options are Kids mode, hide music, automatically hide music during Sefirah and the Three Weeks, hide women singing, hide images of women, hide news, hide statuses, and a daily time limit. The settings also stay locked on the device after signing out.
- **Shabbos & Yom Tov mode.** The whole site closes from candle lighting to havdalah for the chosen city. The home page shows the Hebrew date and the next candle-lighting time.
- **Premium subscription.** Premium removes all ads and allows downloading statuses, shorts and Lichtig-hosted videos. It works with Stripe. Until Stripe is connected, the admin can turn on Premium by hand.
- **Kosher ads.** Only ads the admin uploads are shown, with scheduling, weighting and view and click counts. Premium members see none, and ads are never placed over YouTube videos.
- **Admin panel.** Sections cover the dashboard, adding YouTube videos by link, YouTube search, the review queue, approved channels with auto-sync, ads, users, reports and settings.

## Important limits (YouTube rules)

- YouTube videos are always played through YouTube's official embedded player. They **cannot be downloaded**, and YouTube may show its own ads on some of them. Premium downloads apply to content hosted on Lichtig.
- Only add videos you have the right to show. Embedding a public YouTube video is allowed. Copying videos from other sites is not.

## Settings (environment variables)

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | Postgres connection string. Without it, an embedded database in `./data` is used. |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | Admin login. It is created or updated on every start. |
| `SESSION_SECRET` | Long random string used to sign the parental-lock cookie. |
| `YOUTUBE_API_KEY` | Optional. Turns on YouTube search, video durations and automatic channel sync. |
| `STRIPE_SECRET_KEY`, `STRIPE_PRICE_ID`, `STRIPE_WEBHOOK_SECRET` | Optional. Turns on Premium payments. The webhook URL is `/api/stripe/webhook`. |
| `PUBLIC_URL` | Site address used for Stripe return links (e.g. `https://lichtig.onrender.com`). |
| `MAX_UPLOAD_MB` | Largest upload allowed (default 25). |
| `STORAGE_MODE=demo` | Shows a "test site" note on the sign-in page. |

## Running locally

```bash
npm install
ADMIN_PASSWORD=choose-one npm start   # http://localhost:3000
npm test
```

Built with Node.js, Express, Postgres (or the embedded PGlite database) and plain HTML/CSS/JS. Hebrew dates and zmanim use `@hebcal/core`.
