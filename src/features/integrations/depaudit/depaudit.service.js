'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { API_ROOT } = require('./depaudit.constants');
const { loadExceptions } = require('./depaudit.exceptions');
const { parseAuditReport, evaluateAudit } = require('./depaudit.evaluate');
const { checkPinnedSdks } = require('./depaudit.pin');
const { readDepAuditParams } = require('./depaudit.params');
const { reportFindings, reportPinViolations } = require('./depaudit.report');

const readPackageJson = (root = API_ROOT) => JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

/**
 * Auditoria de dependências de UMA empresa (M9-D248): cruza os avisos high/critical já lidos (`advisories`) com as exceções
 * válidas do arquivo (prazo máximo = parâmetro da empresa), grava um erro de integração por aviso bloqueante, avisa quem
 * gerencia integrações quando o aviso é novo e relata SDK sem versão exata. Roda na transação da empresa.
 */
async function auditCompany(ctx, { advisories, exceptions = loadExceptions(), packageJson = readPackageJson(), now = new Date() }, transaction) {
  const params = await readDepAuditParams(ctx, transaction);
  const result = evaluateAudit({ advisories, exceptions, now, maxDays: params.maxDays });
  const reported = await reportFindings(ctx, result.blocking, transaction);
  const pinned = await reportPinViolations(ctx, checkPinnedSdks(packageJson, params), transaction);
  return { blocking: result.blocking.length, excepted: result.excepted.length, alerted: reported.alerted, notPinned: pinned };
}

module.exports = { auditCompany, readPackageJson, parseAuditReport };
