'use strict';

const fs = require('node:fs');
const path = require('node:path');
const AppError = require('../../../utils/AppError');
const { hashAdapter } = require('./contract.run');
const adapterRegistry = require('../registry/adapterRegistry');

/** Pasta dos relatórios (M9-D222 3.2 item 4): `reports/contract/<provider>.json`; o modo LIVE grava `<provider>.live.json`. `INTEGRATION_CONTRACT_REPORT_DIR` troca a pasta (testes). */
const reportDir = () => process.env.INTEGRATION_CONTRACT_REPORT_DIR || path.join(__dirname, '../../../../reports/contract');
const fileOf = (providerCode, mode = 'SANDBOX') => path.join(reportDir(), `${providerCode}${mode === 'LIVE' ? '.live' : ''}.json`);

function writeReport(report) {
  fs.mkdirSync(reportDir(), { recursive: true });
  fs.writeFileSync(fileOf(report.provider, report.mode), `${JSON.stringify(report, null, 2)}\n`);
  return fileOf(report.provider, report.mode);
}

function readReport(providerCode, mode = 'SANDBOX') {
  const arquivo = fileOf(providerCode, mode);
  if (!fs.existsSync(arquivo)) return null;
  try { return JSON.parse(fs.readFileSync(arquivo, 'utf8')); } catch { return null; }
}

const recusa = (code, message) => AppError.conflict(message, code);

/**
 * Portão do relatório (M9-D222 3.2 itens 4 e 5): a connection só pode ser liberada para produção com o relatório do adapter VERDE (10 cenários, todas as versões), recente
 * (`maxAgeDays`, parâmetro integration.contract.report_validity_days) e do adapter que está no código (o hash confere). `requireLive`: a liberação de produção da M9-D256 exige o
 * relatório do modo LIVE (API real em homologação). Lança 409 com o código do problema; devolve o relatório quando tudo confere.
 */
function assertContractReportForRelease(providerCode, { maxAgeDays, now = new Date(), requireLive = false } = {}) {
  const modo = requireLive ? 'LIVE' : 'SANDBOX';
  const report = readReport(providerCode, modo);
  if (!report) throw recusa('INTEGRATION_CONTRACT_REPORT_MISSING', `Falta o relatório de contract tests (${modo}) deste fornecedor.`);
  if (report.status !== 'PASSED') throw recusa('INTEGRATION_CONTRACT_REPORT_FAILED', 'O relatório de contract tests deste fornecedor tem cenários reprovados.');
  const idade = (now.getTime() - Date.parse(report.generatedAt)) / 86400000;
  if (!Number.isFinite(idade) || idade > maxAgeDays) throw recusa('INTEGRATION_CONTRACT_REPORT_STALE', 'O relatório de contract tests deste fornecedor está vencido: rode a suíte de novo.');
  const instancia = adapterRegistry.instantiate(providerCode);
  if (instancia && hashAdapter(instancia.constructor, providerCode, instancia.supportedVersions()) !== report.adapterHash) {
    throw recusa('INTEGRATION_CONTRACT_REPORT_OUTDATED', 'O adaptador mudou depois do último relatório de contract tests: rode a suíte de novo.');
  }
  return report;
}

module.exports = { writeReport, readReport, assertContractReportForRelease, reportDir, fileOf };
