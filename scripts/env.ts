import { existsSync } from 'node:fs';
// Keep exported production variables authoritative; local files are optional.
if (existsSync('.env.local')) process.loadEnvFile('.env.local');
