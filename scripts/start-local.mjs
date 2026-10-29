// The standalone server reads these documented bind settings before booting.
process.env.HOSTNAME = '127.0.0.1';
process.env.PORT = '3037';
await import('../.next/standalone/server.js');
