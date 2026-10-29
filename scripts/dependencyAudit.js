#!/usr/bin/env node
'use strict';

/**
 * Portão de dependências do CI (M9-D248): `npm audit --omit=dev` bloqueia a entrega com vulnerabilidade high ou critical que
 * não tenha exceção válida em security/audit-exceptions.json (prazo máximo de 30 dias; vencida volta a bloquear), e reprova
 * SDK de fornecedor sem versão exata no package.json.
 * Uso: node scripts/dependencyAudit.js [--report <json do npm audit>] [--exceptions <arquivo>] [--max-days <n>] [--now AAAA-MM-DD]
 * (--report, --exceptions e --now servem à evidência e aos testes; no CI roda sem argumentos).
 */
const fs = require('node:fs');
const path = require('node:path');
const D = '../src/features/integrations/depaudit/';
const { runNpmAudit } = require(`${D}depaudit.runner`);
const { parseAuditReport, evaluateAudit } = require(`${D}depaudit.evaluate`);
const { loadExceptions } = require(`${D}depaudit.exceptions`);
const { checkPinnedSdks } = require(`${D}depaudit.pin`);
const { FAILED_CODE, FAILED_MESSAGE, API_ROOT } = require(`${D}depaudit.constants`);

const arg = (nome) => { const i = process.argv.indexOf(nome); return i > -1 ? process.argv[i + 1] : undefined; };

async function main() {
  const reportFile = arg('--report');
  const report = reportFile ? JSON.parse(fs.readFileSync(path.resolve(reportFile), 'utf8')) : await runNpmAudit();
  const maxDays = Number(arg('--max-days')) || 30;
  const now = arg('--now') ? new Date(`${arg('--now')}T12:00:00Z`) : new Date();
  const exceptions = loadExceptions(arg('--exceptions') ? path.resolve(arg('--exceptions')) : undefined);
  const result = evaluateAudit({ advisories: parseAuditReport(report), exceptions, now, maxDays });
  const pkg = JSON.parse(fs.readFileSync(path.join(API_ROOT, 'package.json'), 'utf8'));
  const naoFixados = checkPinnedSdks(pkg);

  console.log(`dependencyAudit: ${result.blocking.length} bloqueante(s), ${result.excepted.length} com exceção válida, ${result.problems.length} exceção(ões) sem validade, ${naoFixados.length} SDK sem versão exata.`);
  result.excepted.forEach((a) => console.log(`  liberado por exceção até ${a.exception.expiresAt}: ${a.package} ${a.id} (${a.severity}) — responsável ${a.exception.owner}`));
  result.problems.forEach((p) => console.log(`  exceção ${p.exception.id || '(sem id)'} não vale: ${p.reason}`));
  result.blocking.forEach((a) => console.error(`  ${a.severity.toUpperCase()} ${a.package} ${a.id}: ${a.title}${a.exceptionProblem ? ` [exceção: ${a.exceptionProblem}]` : ''}`));
  naoFixados.forEach((v) => console.error(`  ${v.message}`));
  if (result.blocking.length || naoFixados.length) {
    console.error(`${FAILED_CODE}: ${FAILED_MESSAGE}`);
    process.exit(1);
  }
}

main().catch((err) => { console.error(`${FAILED_CODE}: ${err.message}`); process.exit(1); });
