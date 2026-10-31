'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const logger = require('../../../utils/logger');
const { sign } = require('./dry.signature');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const DEFAULT_FILE = path.join('docs', 'governance', 'dry3-report.json');

/** Hash do commit em que o ensaio rodou: GIT_COMMIT do ambiente ou `git rev-parse HEAD` do repositório da API; sem nenhum dos dois, "unknown". */
function currentCommit() {
  if (process.env.GIT_COMMIT) return String(process.env.GIT_COMMIT).trim().slice(0, 64);
  try { return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim().slice(0, 64); } catch (err) { return 'unknown'; }
}

/**
 * Caminho do arquivo exportado: `MIGRATION_DRY3_REPORT_PATH` (laboratório e testes) ou docs/governance/dry3-report.json do repositório. Com NODE_ENV=test e sem caminho explícito, o arquivo
 * vai para o diretório temporário: um teste (ou ensaio de desenvolvimento) nunca sobrescreve o relatório oficial do repositório.
 */
function exportPath() {
  if (process.env.MIGRATION_DRY3_REPORT_PATH) return path.resolve(process.env.MIGRATION_DRY3_REPORT_PATH);
  if (process.env.NODE_ENV === 'test') return path.join(os.tmpdir(), 'nayara-dry3-report.test.json');
  return path.join(REPO_ROOT, DEFAULT_FILE);
}

/**
 * Exporta a conclusão do DRY3 (M9-D908 §3.4) para o arquivo que o fechamento do bloco F (M9-D940) lê: conclusion, criteria, commit e generated_at, mais report_id e a assinatura. O arquivo não leva dado
 * pessoal (só contagens, códigos e nomes de critério). Escrita atômica (arquivo temporário e renomeação).
 */
function exportReport(report, { companyId } = {}) {
  const file = exportPath();
  const body = {
    conclusion: report.conclusion,
    criteria: report.criteria,
    commit: report.commit || currentCommit(),
    generated_at: new Date().toISOString(),
    report_id: report.id,
    company_id: companyId || null, // vínculo à empresa: assinado, para o GO de outra empresa não aceitar este relatório
  };
  const signature = sign(body); // assinatura HMAC com a chave do ambiente: o GO só aceita relatório assinado e intacto
  if (signature) Object.assign(body, signature); else logger.warn({ reportId: report.id }, 'migration.dry3.export.unsigned');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(body, null, 2)}\n`);
  fs.renameSync(tmp, file);
  return { file, body };
}

module.exports = { exportReport, exportPath, currentCommit };
