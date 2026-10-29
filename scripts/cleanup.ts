import './env';
import { db } from '../src/server/db';
import { cleanupMedia } from '../src/server/maintenance';
try { console.log(`Removed media for ${await cleanupMedia()} expired or deleted takes.`); }
finally { await db().end(); }
