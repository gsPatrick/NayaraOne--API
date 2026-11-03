'use strict';

/**
 * Backup do storage de arquivos (complemento de scripts/backupDatabase.js).
 *
 * Os bytes dos arquivos NÃO estão no banco: ficam cifrados em disco (src/utils/diskStorage.js,
 * src/utils/fileCrypto.js) em UPLOADS_DIR (padrão: uploads/ na raiz). Um backup só do banco
 * deixaria people.files apontando para storage_keys sem conteúdo. Este script copia a árvore de
 * arquivos para um diretório de backup e grava um manifest.json com caminho relativo, tamanho e
 * SHA-256 de cada blob (cifrado, como está em disco) — scripts/restoreStorage.js confere o
 * manifesto na volta.
 *
 * A chave FILES_ENCRYPTION_KEY NÃO vai no backup (não é dado, é segredo): sem a mesma chave no
 * ambiente restaurado, os blobs restaurados são ilegíveis. Guardar a chave é procedimento à
 * parte, documentado no runbook.
 *
 * Uso: node scripts/backupStorage.js --out <diretorio> [--source <diretorio-de-uploads>]
 */

require('dotenv').config();
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--out' && argv[i + 1]) { out.out = argv[i + 1]; i += 1; }
    if (argv[i] === '--source' && argv[i + 1]) { out.source = argv[i + 1]; i += 1; }
  }
  return out;
}

function listFiles(root) {
  return fs.readdirSync(root, { recursive: true })
    .map((rel) => String(rel))
    .filter((rel) => fs.statSync(path.join(root, rel)).isFile())
    .sort();
}

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function main() {
  const { out, source } = parseArgs(process.argv.slice(2));
  if (!out) throw new Error('Uso: node scripts/backupStorage.js --out <diretorio> [--source <uploads>]');
  const sourceDir = path.resolve(source || process.env.UPLOADS_DIR || path.join(__dirname, '..', 'uploads'));
  if (!fs.existsSync(sourceDir)) throw new Error(`Diretório de uploads não encontrado: ${sourceDir}`);

  const filesDir = path.join(out, 'files');
  fs.mkdirSync(filesDir, { recursive: true });

  const entries = [];
  for (const rel of listFiles(sourceDir)) {
    const from = path.join(sourceDir, rel);
    const to = path.join(filesDir, rel);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
    const hash = sha256File(from);
    if (sha256File(to) !== hash) throw new Error(`Cópia divergente: ${rel}`);
    entries.push({ path: rel, sizeBytes: fs.statSync(from).size, sha256: hash });
  }
  if (entries.length === 0) throw new Error(`Nenhum arquivo em ${sourceDir} — backup de storage vazio recusado.`);

  const manifest = { createdAt: new Date().toISOString(), sourceDir, fileCount: entries.length, files: entries };
  fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify(manifest, null, 2));
  console.log(`Backup do storage gerado: ${entries.length} arquivo(s) em ${out} (manifest.json com SHA-256 por arquivo).`);
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
