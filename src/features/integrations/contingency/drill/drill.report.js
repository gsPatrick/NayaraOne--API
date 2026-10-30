'use strict';

const fs = require('node:fs');
const path = require('node:path');

/** Pasta dos relatórios do ensaio: `INTEGRATION_DRILL_REPORT_DIR` (testes) ou docs/evidencias/contingencia. */
const DEFAULT_DIR = path.resolve(__dirname, '../../../../../docs/evidencias/contingencia');
const reportDir = () => process.env.INTEGRATION_DRILL_REPORT_DIR || DEFAULT_DIR;

/** Relatório do ensaio (exigido pela M9-D256): JSON com cada passo, o resultado, o veredito e o hash do adapter ensaiado (relatório de adapter alterado não vale). Não leva segredo, endereço nem dado pessoal. */
function newReport({ provider, scenario, companyId, startedAt }) {
  return { schemaVersion: 1, kind: 'contingency-failure-drill', provider, scenario, companyId, adapterHash: null, startedAt: startedAt.toISOString(), finishedAt: null, steps: [], passed: false };
}

function addStep(report, name, ok, detail) {
  report.steps.push({ name, ok: Boolean(ok), detail: detail === undefined ? null : detail });
  return Boolean(ok);
}

function finish(report, finishedAt) {
  report.finishedAt = finishedAt.toISOString();
  report.passed = report.steps.length > 0 && report.steps.every((s) => s.ok);
  return report;
}

/** Grava o relatório em `dir` (criada se preciso) e devolve o caminho. */
function writeReport(report, dir) {
  fs.mkdirSync(dir, { recursive: true });
  const carimbo = report.startedAt.replace(/[-:T]/g, '').slice(0, 14);
  const file = path.join(dir, `failure-drill-${report.provider}-${report.scenario}-${carimbo}.json`);
  fs.writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return file;
}

module.exports = { newReport, addStep, finish, writeReport, reportDir, DEFAULT_DIR };
