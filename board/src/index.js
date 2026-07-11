import { createServer } from './app.js';

const port = Number(process.env.PORT) || 3000;
const token = process.env.SHIPIT_TOKEN || null;

createServer({ port, token });

if (token) {
  console.log(`[board] Mission Control on :${port} — auth ENFORCED (Bearer $SHIPIT_TOKEN)`);
} else {
  console.warn('[board] SHIPIT_TOKEN unset — accepting UNAUTHENTICATED events (dev mode)');
  console.log(`[board] Mission Control on :${port}`);
}
