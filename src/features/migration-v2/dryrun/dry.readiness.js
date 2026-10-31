'use strict';

const fs = require('node:fs');
const readiness = require('../rollback/readiness');
const { exportPath } = require('./dry.export');
const { verify } = require('./dry.signature');

const GAP = 'GOV_MIG_DRY3_ROLLBACK_NOT_SIMULATED';
const NAME = 'dry3-rollback-simulation';

const REASONS = Object.freeze({
  NO_FILE: 'O relatório exportado do ensaio DRY3 não foi encontrado.',
  UNREADABLE: 'O relatório exportado do ensaio DRY3 não pode ser lido.',
  KEY_MISSING: 'A chave de assinatura do relatório do ensaio DRY3 não está configurada neste ambiente.',
  UNSIGNED: 'O relatório exportado do ensaio DRY3 não está assinado.',
  SIGNATURE_MISMATCH: 'O relatório exportado do ensaio DRY3 foi alterado depois de assinado.',
  NOT_APPROVED: 'O ensaio DRY3 exportado não foi APROVADO.',
  NOT_SIMULATED: 'A simulação de rollback do ensaio DRY3 exportado não foi concluída.',
});

const gap = (reason, report) => [{ code: GAP, detail: { reportId: (report && report.report_id) || null, reason: REASONS[reason] } }];

/**
 * Pré-requisito do GO (M9-D907 §3.4, recebido na M9-D908): a simulação de rollback tem de ter sido executada no DRY3. O ensaio só roda em banco descartável (dry.guard), então o GO
 * não lê a tabela do banco do ensaio: reconhece o relatório EXPORTADO (docs/governance/dry3-report.json, ou MIGRATION_DRY3_REPORT_PATH), cuja assinatura HMAC (dry.signature) amarra
 * report_id, conclusão, critérios, commit e data. Arquivo ausente, sem assinatura, adulterado, ensaio não APROVADO ou simulação vermelha: 409 GOV_CUTOVER_NOT_READY com { code, detail }.
 */
async function rollbackSimulated() {
  let report;
  try { report = JSON.parse(fs.readFileSync(exportPath(), 'utf8')); } catch (err) { return gap(err.code === 'ENOENT' ? 'NO_FILE' : 'UNREADABLE'); }
  const signed = verify(report);
  if (!signed.ok) return gap(signed.reason, report);
  if (report.conclusion !== 'APROVADO') return gap('NOT_APPROVED', report);
  const criterion = report.criteria && report.criteria.rollback_simulated;
  return criterion && criterion.ok === true ? [] : gap('NOT_SIMULATED', report);
}

/** Registro explícito no ponto de extensão do GO (idempotente); chamado pela montagem das rotas, não por efeito colateral de import. */
const install = () => readiness.register(NAME, rollbackSimulated);

module.exports = { rollbackSimulated, install, GAP, NAME };
