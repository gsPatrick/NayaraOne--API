#!/usr/bin/env node
'use strict';
/**
 * Teste de restauração dos anexos, de ponta a ponta:
 *   1. escolhe arquivos reais da empresa de teste (registro no banco + blob cifrado em disco);
 *   2. faz o backup do storage (scripts/backupStorage.js, manifesto SHA-256 por blob);
 *   3. restaura num diretório novo e vazio (scripts/restoreStorage.js, confere o manifesto);
 *   4. abre cada arquivo restaurado, decifra com a chave e compara o SHA-256 com o do cadastro;
 *   5. prova que a chave é indispensável: chave errada e chave ausente falham; blob adulterado falha.
 * Grava o resultado em JSON (--out) para a página de evidências.
 *
 *   node scripts/restoreDrill/storageRestoreDrill.js --out <arquivo.json> [--max 5]
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const args = process.argv.slice(2);
const arg = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };

// Modo filho: abre UM arquivo no storage restaurado (UPLOADS_DIR já aponta para a cópia restaurada).
if (args[0] === '--abrir') {
  require('dotenv').config({ path: path.join(ROOT, '.env') });
  if (process.env.__SEM_CHAVE === '1') delete process.env.FILES_ENCRYPTION_KEY;
  if (process.env.__CHAVE_ERRADA) process.env.FILES_ENCRYPTION_KEY = process.env.__CHAVE_ERRADA;
  const diskStorage = require(path.join(ROOT, 'src/utils/diskStorage'));
  const { decryptFileBuffer } = require(path.join(ROOT, 'src/utils/fileCrypto'));
  try {
    const buf = decryptFileBuffer(diskStorage.readFile(args[1]));
    process.stdout.write(JSON.stringify({ ok: true, sha256: crypto.createHash('sha256').update(buf).digest('hex'), bytes: buf.length }));
  } catch (e) {
    process.stdout.write(JSON.stringify({ ok: false, codigo: e.code || e.name, mensagem: String(e.message).slice(0, 120) }));
  }
  process.exit(0);
}

(async () => {
  require('dotenv').config({ path: path.join(ROOT, '.env') });
  const { sequelize, getSeedTenant, withRollbackTenantTransaction } = require(path.join(ROOT, 'test/testHelpers'));
  const tenant = await getSeedTenant();
  const max = Number(arg('--max', 5));
  const uploads = path.resolve(process.env.UPLOADS_DIR || path.join(ROOT, 'uploads'));

  let candidatos = [];
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const [rows] = await sequelize.query(
      `SELECT id, file_name, mime_type, storage_key, checksum_sha256, size_bytes
         FROM people.files
        WHERE encrypted_at_rest = true AND storage_key NOT LIKE 'local-db/%' AND checksum_sha256 IS NOT NULL
        ORDER BY created_at DESC LIMIT 60`,
      { transaction }
    );
    candidatos = rows.filter((r) => fs.existsSync(path.join(uploads, r.storage_key))).slice(0, max);
  });
  await sequelize.close();
  if (candidatos.length === 0) throw new Error('Nenhum anexo cifrado com blob em disco encontrado para o teste.');

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'restore-anexos-'));
  const backupDir = path.join(tmp, 'backup');
  const restored = path.join(tmp, 'uploads-restaurado');
  const node = (script, scriptArgs, env = {}) => spawnSync('node', [path.join(ROOT, script), ...scriptArgs], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, ...env } });

  const b = node('scripts/backupStorage.js', ['--out', backupDir, '--source', uploads]);
  if (b.status !== 0) throw new Error(`backup falhou: ${b.stderr || b.stdout}`);
  const manifest = JSON.parse(fs.readFileSync(path.join(backupDir, 'manifest.json'), 'utf8'));
  const r = node('scripts/restoreStorage.js', ['--backup', backupDir, '--target', restored]);
  if (r.status !== 0) throw new Error(`restauração falhou: ${r.stderr || r.stdout}`);

  const abrir = (storageKey, env = {}) => {
    const x = spawnSync('node', [__filename, '--abrir', storageKey], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, UPLOADS_DIR: restored, ...env } });
    try { return JSON.parse(x.stdout); } catch { return { ok: false, codigo: 'SAIDA_INVALIDA', mensagem: (x.stderr || x.stdout).slice(0, 120) }; }
  };

  const arquivos = candidatos.map((c) => {
    const aberto = abrir(c.storage_key);
    return { arquivo: c.file_name, tipo: c.mime_type, bytesDoCadastro: Number(c.size_bytes), bytesAbertos: aberto.bytes ?? null, abriu: aberto.ok, sha256Confere: aberto.ok && aberto.sha256 === c.checksum_sha256, sha256: c.checksum_sha256 };
  });
  const primeiro = candidatos[0].storage_key;
  const semChave = abrir(primeiro, { __SEM_CHAVE: '1' });
  const chaveErrada = abrir(primeiro, { __CHAVE_ERRADA: crypto.randomBytes(32).toString('hex') });
  const blob = path.join(restored, primeiro);
  const original = fs.readFileSync(blob);
  const adulterado = Buffer.from(original);
  adulterado[adulterado.length - 1] ^= 0xff;
  fs.writeFileSync(blob, adulterado);
  const blobAdulterado = abrir(primeiro);
  fs.writeFileSync(blob, original);

  const resultado = {
    executadoEm: new Date().toISOString(),
    arquivosNoBackup: manifest.files?.length ?? manifest.entries?.length ?? null,
    arquivosTestados: arquivos,
    todosAbriramEConferem: arquivos.every((a) => a.abriu && a.sha256Confere),
    semChave: { recusou: !semChave.ok, codigo: semChave.codigo },
    chaveErrada: { recusou: !chaveErrada.ok, codigo: chaveErrada.codigo },
    blobAdulterado: { recusou: !blobAdulterado.ok, codigo: blobAdulterado.codigo },
    observacao: 'A chave FILES_ENCRYPTION_KEY não vai dentro do backup. Sem a mesma chave os arquivos restaurados não abrem.',
  };
  fs.rmSync(tmp, { recursive: true, force: true });
  const out = arg('--out');
  if (out) fs.writeFileSync(out, JSON.stringify(resultado, null, 2));
  console.log(JSON.stringify(resultado, null, 2));
  process.exit(resultado.todosAbriramEConferem && resultado.semChave.recusou && resultado.chaveErrada.recusou && resultado.blobAdulterado.recusou ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
