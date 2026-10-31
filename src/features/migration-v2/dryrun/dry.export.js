'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const logger = require('../../../utils/logger');
const { sign } = require('./dry.signature');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const DEFAULT_FILE = path.join('docs', 'governance', 'dry3-report.json');

const VERSION_FILE = path.join(REPO_ROOT, 'VERSION');
const clean = (text) => String(text == null ? '' : text).trim().slice(0, 64);

/**
 * Hash do commit em que o ensaio rodou, na ordem: GIT_COMMIT do ambiente; arquivo VERSION da raiz da API (a imagem Docker grava ali o SHA do build, o contêiner não tem .git);
 * `git rev-parse HEAD` do repositório (desenvolvimento); sem nenhum deles, "unknown". Um VERSION vazio ou "unknown" (build sem GIT_SHA) não conta como commit.
 */
function currentCommit({ versionFile = VERSION_FILE } = {}) {
  if (clean(process.env.GIT_COMMIT)) return clean(process.env.GIT_COMMIT);
  try { const fromImage = clean(fs.readFileSync(versionFile, 'utf8')); if (fromImage && fromImage !== 'unknown') return fromImage; } catch (err) { /* sem VERSION fora da imagem: segue para o git */ }
  try { return clean(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'ignore'] }).toString()) || 'unknown'; } catch (err) { return 'unknown'; }
}

/** Arquivo-base: `MIGRATION_DRY3_REPORT_PATH` (laboratório e testes) ou docs/governance/dry3-report.json; com NODE_ENV=test e sem caminho explícito, no diretório temporário (um teste nunca sobrescreve o oficial). */
function basePath() {
  if (process.env.MIGRATION_DRY3_REPORT_PATH) return path.resolve(process.env.MIGRATION_DRY3_REPORT_PATH);
  if (process.env.NODE_ENV === 'test') return path.join(os.tmpdir(), 'nayara-dry3-report.test.json');
  return path.join(REPO_ROOT, DEFAULT_FILE);
}

/**
 * Caminho do relatório exportado. Sem empresa: o arquivo-base (o que o fechamento do bloco F, M9-D940, lê). Com empresa: um arquivo por empresa ao lado do base
 * (`dry3-report.<empresa>.json`), o que o GO dessa empresa lê; assim o ensaio de uma empresa nunca sobrescreve o de outra (reabertura R3-L4).
 */
function exportPath(companyId) {
  const base = basePath();
  if (!companyId) return base;
  const ext = path.extname(base);
  return `${base.slice(0, base.length - ext.length)}.${companyId}${ext}`;
}

function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

/**
 * Exporta a conclusão do DRY3 (M9-D908 §3.4) para o arquivo que o fechamento do bloco F (M9-D940) lê: conclusion, criteria, commit e generated_at, mais report_id e a assinatura. O arquivo não leva dado
 * pessoal (só contagens, códigos e nomes de critério). Escrita atômica (arquivo temporário e renomeação).
 */
function exportReport(report, { companyId } = {}) {
  const file = exportPath(companyId);
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
  const text = `${JSON.stringify(body, null, 2)}\n`;
  writeAtomic(file, text);
  if (companyId) writeAtomic(exportPath(), text); // cópia no arquivo-base: último ensaio do ambiente, lido pelo fechamento do bloco (D940)
  return { file, body };
}

module.exports = { exportReport, exportPath, currentCommit };
