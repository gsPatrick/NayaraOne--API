'use strict';

/**
 * Backup AGENDADO do banco (pendência da frente 7 — RUNBOOK_RESTORE.md §6: "RPO não garantido,
 * backup manual"). Feito para rodar sem ninguém olhando (cron / systemd timer — ver
 * docs/runbooks/BACKUP_AGENDADO.md):
 *
 *   1. pg_dump -Fc pelo script real (scripts/backupDatabase.js — credencial de DDL só no dump);
 *   2. verificação do dump em claro: `pg_restore --list` precisa ler o catálogo inteiro;
 *   3. criptografia AES-256-GCM (chave BACKUP_ENCRYPTION_KEY, 64 hex, guardada FORA do servidor)
 *      → <nome>.dump.enc + <nome>.dump.enc.sha256; o dump em claro é apagado;
 *   4. verificação do cifrado: decifra para um temporário, confere a tag GCM, o SHA-256 do
 *      conteúdo e roda `pg_restore --list` de novo — backup que não volta não conta;
 *   5. retenção: apaga cifrados mais antigos que BACKUP_RETENTION_DAYS (padrão 14), mas nunca
 *      deixa menos que BACKUP_MIN_KEEP (padrão 3);
 *   6. cópia externa opcional: BACKUP_OFFSITE_CMD (ex.: `rclone copy {file} remoto:nayara-bkp`),
 *      com {file} substituído pelo cifrado; falha da cópia = exit 1.
 * Sai com código ≠ 0 em qualquer falha (o cron/systemd e o monitor enxergam). Grava uma linha de
 * status em <BACKUP_DIR>/last-backup.json (data, arquivo, tamanho, sha256, duração).
 *
 * Variáveis: DATABASE_URL (ou DB_*), DB_MIGRATION_USER/PASSWORD (.env.migration.local),
 * BACKUP_DIR, BACKUP_ENCRYPTION_KEY, BACKUP_RETENTION_DAYS, BACKUP_MIN_KEEP, BACKUP_OFFSITE_CMD.
 * Decifrar para restore: node scripts/decryptBackup.js --in <arquivo.dump.enc> --out <arquivo.dump>
 */

require('dotenv').config();
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const backupDatabase = require('./backupDatabase');
const { encryptFile, decryptFile, sha256File, loadKey } = require('./lib/backupCrypto');

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

function pgRestoreList(file) {
  const out = execFileSync(backupDatabase.resolveBinary('pg_restore'), ['--list', file], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  const entries = out.split('\n').filter((l) => l && !l.startsWith(';')).length;
  if (entries === 0) throw new Error(`pg_restore --list não encontrou nenhum objeto em ${path.basename(file)}`);
  return entries;
}

function applyRetention(dir, days, minKeep) {
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.dump.enc'))
    .map((f) => ({ f, mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  const cutoff = Date.now() - days * 86400000;
  const removed = [];
  files.forEach(({ f, mtime }, idx) => {
    if (idx >= minKeep && mtime < cutoff) {
      fs.rmSync(path.join(dir, f), { force: true });
      fs.rmSync(path.join(dir, `${f}.sha256`), { force: true });
      removed.push(f);
    }
  });
  return { kept: files.length - removed.length, removed };
}

async function main() {
  const started = Date.now();
  const key = loadKey(process.env.BACKUP_ENCRYPTION_KEY);
  const dir = path.resolve(process.env.BACKUP_DIR || path.join(__dirname, '..', 'backups'));
  const days = Number(process.env.BACKUP_RETENTION_DAYS) || 14;
  const minKeep = Number(process.env.BACKUP_MIN_KEEP) || 3;
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

  // 1. dump em claro num diretório privado temporário (nunca no BACKUP_DIR).
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nayara-bkp-'));
  try {
    process.argv = [process.argv[0], process.argv[1], '--out', tmp];
    const plain = await backupDatabase.main();
    const plainSha = await sha256File(plain);
    const entries = pgRestoreList(plain);
    log(`dump ok: ${path.basename(plain)} (${(fs.statSync(plain).size / 1048576).toFixed(2)} MB, ${entries} objetos no catálogo)`);

    // 3. cifra.
    const enc = path.join(dir, `${path.basename(plain)}.enc`);
    await encryptFile(plain, enc, key);
    fs.chmodSync(enc, 0o600);
    const encSha = await sha256File(enc);
    fs.writeFileSync(`${enc}.sha256`, `${encSha}  ${path.basename(enc)}\n`, { mode: 0o600 });
    fs.rmSync(plain, { force: true });

    // 4. verifica o cifrado de ponta a ponta.
    const check = path.join(tmp, 'verify.dump');
    await decryptFile(enc, check, key);
    const back = await sha256File(check);
    if (back !== plainSha) throw new Error('verificação falhou: conteúdo decifrado difere do dump original');
    const entries2 = pgRestoreList(check);
    fs.rmSync(check, { force: true });
    log(`cifrado ok: ${path.basename(enc)} (sha256 ${encSha.slice(0, 16)}…); decifrado confere com o original e pg_restore lê ${entries2} objetos`);

    // 6. cópia externa.
    if (process.env.BACKUP_OFFSITE_CMD) {
      const cmd = process.env.BACKUP_OFFSITE_CMD.replace(/\{file\}/g, enc);
      const res = spawnSync('sh', ['-c', cmd], { encoding: 'utf8' });
      if (res.status !== 0) throw new Error(`cópia externa falhou (exit ${res.status}): ${(res.stderr || '').trim().slice(0, 300)}`);
      const resSha = spawnSync('sh', ['-c', process.env.BACKUP_OFFSITE_CMD.replace(/\{file\}/g, `${enc}.sha256`)], { encoding: 'utf8' });
      if (resSha.status !== 0) throw new Error('cópia externa do .sha256 falhou');
      log('cópia externa ok');
    } else {
      log('AVISO: BACKUP_OFFSITE_CMD não definido — o backup ficou só neste servidor.');
    }

    // 5. retenção.
    const ret = applyRetention(dir, days, minKeep);
    log(`retenção (${days} dias, mínimo ${minKeep}): ${ret.kept} mantido(s), ${ret.removed.length} removido(s)${ret.removed.length ? `: ${ret.removed.join(', ')}` : ''}`);

    const status = { ok: true, date: new Date().toISOString(), file: path.basename(enc), bytes: fs.statSync(enc).size, sha256: encSha, catalogEntries: entries, durationSeconds: (Date.now() - started) / 1000, offsite: Boolean(process.env.BACKUP_OFFSITE_CMD), kept: ret.kept };
    fs.writeFileSync(path.join(dir, 'last-backup.json'), `${JSON.stringify(status, null, 2)}\n`);
    log(`backup agendado concluído em ${status.durationSeconds.toFixed(1)} s`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

main().catch((err) => {
  log(`FALHA no backup agendado: ${err.message}`);
  process.exit(1);
});
