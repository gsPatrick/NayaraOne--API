'use strict';

const { parseContract, majorOf } = require('./openapi.load');
const { diffContracts } = require('./diff.index');
const { parseErrorCatalog } = require('./diff.errorCodes');
const { planVersion } = require('./versions');
const { parseScope, undocumentedRoutes } = require('./scope');
const { EXIT, breakingMessage, undocumentedMessage, BREAKING_CODE, UNDOCUMENTED_CODE } = require('./openapi.errors');

/**
 * Lint do contrato (M9-D840): compara a base com a candidata e confere a cobertura das rotas reais do escopo. Não lê banco. Lança GOV_OPENAPI_INVALID (exit 2) para contrato
 * inválido. `base` pode ser null (primeiro contrato: nada a comparar). Devolve o relatório { exitCode, ok, base, candidate, mode, changes, undocumented, text }.
 */
function lintContracts({ baseText, candidateText, candidatePath, routes, scopeJson, errorCatalogText }) {
  const candidate = parseContract(candidateText, 'contrato candidato');
  const base = baseText ? parseContract(baseText, 'contrato base') : null;
  const catalog = errorCatalogText ? parseErrorCatalog(errorCatalogText) : null;
  const report = {
    exitCode: EXIT.OK, ok: true, candidate: candidate.info.version, base: base ? base.info.version : null, mode: base ? 'compare' : 'first', changes: [], undocumented: [],
  };
  if (base) {
    const plan = planVersion(base, candidate, candidatePath, parseContract);
    report.mode = plan.mode;
    const major = plan.baseMajor;
    for (const problem of plan.problems) report.changes.push({ code: BREAKING_CODE, rule: problem.rule, ruleNumber: null, where: problem.where, message: breakingMessage(major, problem.rule, problem.where), detail: problem.detail });
    if (plan.mode === 'compare') {
      for (const item of diffContracts(base, candidate, { errorCatalog: catalog })) {
        report.changes.push({ code: BREAKING_CODE, rule: item.rule, ruleNumber: item.ruleNumber, where: item.where, message: breakingMessage(major, item.rule, item.where), detail: item.detail });
      }
    }
  } else if (catalog) {
    for (const item of diffContracts(candidate, candidate, { errorCatalog: catalog })) report.changes.push({ code: BREAKING_CODE, rule: item.rule, ruleNumber: item.ruleNumber, where: item.where, message: breakingMessage(majorOf(candidate), item.rule, item.where), detail: item.detail });
  }
  if (routes && scopeJson) {
    for (const route of undocumentedRoutes(candidate, routes, parseScope(scopeJson))) report.undocumented.push({ code: UNDOCUMENTED_CODE, method: route.method, path: route.path, message: undocumentedMessage(route.method, route.path) });
  }
  if (report.changes.length || report.undocumented.length) { report.ok = false; report.exitCode = EXIT.FAILED; }
  report.text = [
    `Contrato ${report.base ? `${report.base} -> ` : ''}${report.candidate} (${report.mode}).`,
    ...report.changes.map((c) => `${c.code} [regra ${c.ruleNumber || '-'}: ${c.rule}] ${c.message} ${c.detail || ''}`.trim()),
    ...report.undocumented.map((u) => `${u.code} ${u.message}`),
    report.ok ? 'OK: nenhuma mudança incompatível e todas as rotas do escopo estão documentadas.' : `FALHOU: ${report.changes.length} mudança(s) incompatível(is), ${report.undocumented.length} rota(s) sem documentação.`,
  ].join('\n');
  return report;
}

module.exports = { lintContracts };
