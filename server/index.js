import { initDb, closeDb } from './db.js';
import { seed } from './seed.js';
import { createApp } from './app.js';
import { pruneSessions } from './auth.js';
import { syncDueChannels } from './admin.js';
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

// Check followed channels for new uploads. On a free Render plan the server sleeps when
// idle, so instead of waiting for a long timer it checks shortly after every wake-up and
// then every 30 minutes; each channel is only fetched once it's 6 hours old.
const checkChannels = () => syncDueChannels().catch((err) => console.warn('Channel check failed:', err.message));
timers.push(setTimeout(checkChannels, 20 * 1000), setInterval(checkChannels, 30 * 60 * 1000));
timers.forEach((t) => t.unref());

const shutdown = () =>
  server.close(async () => {
    await closeDb();
    process.exit(0);
  });
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
