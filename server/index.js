import { initDb, closeDb, many } from './db.js';
import { seed } from './seed.js';
import { createApp } from './app.js';
import { pruneSessions } from './auth.js';
import { hasApiKey } from './youtube.js';
import { syncChannel } from './admin.js';
import { failInterruptedImports } from './importer.js';
import { cleanupOrphans } from './media.js';
import { storageEnabled } from './storage.js';

await initDb();
await seed();
await pruneSessions();
await failInterruptedImports();

const port = Number(process.env.PORT) || 3000;
const server = createApp().listen(port, '0.0.0.0', () => {
  console.log(`Lichtig is running on http://localhost:${port}`);
  console.log(`Video storage: ${storageEnabled() ? 'cloud (S3/R2)' : 'database'}`);
});
// Large uploads can take a while on slow connections.
server.requestTimeout = 0;
server.headersTimeout = 120 * 1000;

const timers = [
  setInterval(() => pruneSessions().catch(() => {}), 6 * 3600 * 1000),
  setInterval(() => cleanupOrphans().catch((err) => console.warn('Cleanup failed:', err.message)), 12 * 3600 * 1000),
];

// Pull new uploads from approved channels every 6 hours when a YouTube API key is set.
if (hasApiKey()) {
  const syncAll = async () => {
    for (const ch of await many('SELECT * FROM channels WHERE yt_channel_id IS NOT NULL OR url LIKE $1', ['https://%'])) {
      await syncChannel(ch).catch((err) => console.warn('Channel sync failed:', ch.url, err.message));
    }
  };
  timers.push(setInterval(() => syncAll().catch(() => {}), 6 * 3600 * 1000));
}
timers.forEach((t) => t.unref());

const shutdown = () =>
  server.close(async () => {
    await closeDb();
    process.exit(0);
  });
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
