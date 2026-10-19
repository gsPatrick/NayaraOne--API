'use strict';

/**
 * Restore do storage de arquivos gerado por scripts/backupStorage.js.
 *
 * Copia os blobs do backup para o diretório de uploads do ambiente restaurado e confere cada
 * arquivo contra o manifest.json (tamanho e SHA-256 do blob cifrado). Falha se qualquer arquivo
 * faltar ou divergir, e recusa um diretório de destino que já tenha conteúdo (restore de teste
 * é sempre num destino limpo — nunca sobrescreve o storage de um ambiente em uso).
 *
 * Uso: node scripts/restoreStorage.js --backup <diretorio-do-backup> --target <diretorio-de-uploads>
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--backup' && argv[i + 1]) { out.backup = argv[i + 1]; i += 1; }
    if (argv[i] === '--target' && argv[i + 1]) { out.target = argv[i + 1]; i += 1; }
  }
  return out;
}

function main() {
  const { backup, target } = parseArgs(process.argv.slice(2));
  if (!backup || !target) throw new Error('Uso: node scripts/restoreStorage.js --backup <dir> --target <uploads>');
  const manifest = JSON.parse(fs.readFileSync(path.join(backup, 'manifest.json'), 'utf8'));
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) throw new Error('Manifesto vazio — nada para restaurar.');
  if (fs.existsSync(target) && fs.readdirSync(target).length > 0) {
    throw new Error(`Recusado: ${target} já tem conteúdo. Restore de storage só em diretório vazio.`);
  }

  let restored = 0;
  for (const entry of manifest.files) {
    const from = path.join(backup, 'files', entry.path);
    const to = path.join(target, entry.path);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
    const bytes = fs.readFileSync(to);
    const hash = crypto.createHash('sha256').update(bytes).digest('hex');
    if (bytes.length !== entry.sizeBytes || hash !== entry.sha256) {
      throw new Error(`Arquivo restaurado diverge do manifesto: ${entry.path}`);
    }
    restored += 1;
  }
  console.log(`Restore do storage concluído: ${restored}/${manifest.files.length} arquivo(s) conferidos contra o manifesto em ${target}.`);
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  }
}

module.exports = { main };
