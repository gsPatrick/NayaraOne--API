'use strict';

/**
 * Decifra um backup gerado por scripts/scheduledBackup.js para um .dump que o
 * `npm run restore -- --file <dump> --target-db <banco>` aceita.
 * Uso: BACKUP_ENCRYPTION_KEY=<64 hex> node scripts/decryptBackup.js --in <arquivo.dump.enc> --out <arquivo.dump>
 */

require('dotenv').config();
const { decryptFile, loadKey, sha256File } = require('./lib/backupCrypto');

async function main() {
  const argv = process.argv.slice(2);
  const arg = (n) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : null);
  if (!arg('--in') || !arg('--out')) throw new Error('Uso: --in <arquivo.dump.enc> --out <arquivo.dump>');
  await decryptFile(arg('--in'), arg('--out'), loadKey(process.env.BACKUP_ENCRYPTION_KEY));
  console.log(`Decifrado: ${arg('--out')} (sha256 ${await sha256File(arg('--out'))})`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
