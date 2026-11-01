'use strict';

const fs = require('node:fs');
const readiness = require('../rollback/readiness');
const { exportPath } = require('./dry.export');
const { verify } = require('./dry.signature');
const { bindingProblem } = require('./dry.validity');

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
  NO_REPORT_ID: 'O relatório exportado do ensaio DRY3 não traz o identificador do ensaio.',
  OTHER_COMPANY: 'O relatório exportado do ensaio DRY3 é de outra empresa.',
  CRITERIA_RED: 'O ensaio DRY3 exportado tem critério de aprovação reprovado ou ausente',
  BATCHES_PENDING: 'O ensaio DRY3 exportado tem lotes que não foram todos verificados',
  VOLUME_BELOW_MINIMUM: 'O ensaio DRY3 exportado não atingiu o volume mínimo de linhas exigido',
  OTHER_COMMIT: 'O relatório exportado do ensaio DRY3 é de outro commit que não o em execução.',
  DIRTY_TREE: 'O ensaio DRY3 exportado rodou com alteração não commitada no código: o commit registrado não descreve o que foi testado.',
  BAD_DATE: 'O relatório exportado do ensaio DRY3 tem data de geração ausente ou inválida (data de geração).',
  EXPIRED: 'O relatório exportado do ensaio DRY3 é mais velho que o prazo de validade permitido.',
});

const gap = (reason, report, extra = {}) => [{ code: GAP, detail: { reportId: (report && report.report_id) || null, reason: REASONS[reason] + (extra.red ? `: ${extra.red.join(', ')}.` : extra.total !== undefined ? ` (${extra.verified} de ${extra.total}).` : extra.minimum ? ` (${extra.rows === null ? 'sem contagem' : extra.rows} de ${extra.minimum}).` : ''), ...extra } }];

/**
 * Pré-requisito do GO (M9-D907 §3.4, recebido na M9-D908): a simulação de rollback tem de ter sido executada no DRY3. O ensaio só roda em banco descartável (dry.guard), então o GO
 * não lê a tabela do banco do ensaio: reconhece o relatório EXPORTADO (um arquivo por empresa ao lado de docs/governance/dry3-report.json, ou de MIGRATION_DRY3_REPORT_PATH), cuja assinatura HMAC (dry.signature) amarra
 * report_id, conclusão, critérios, commit e data. Além da assinatura, o vínculo (dry.validity, N2): empresa, commit, idade, seis critérios, lotes e volume mínimo (parâmetros). Qualquer falha: 409 GOV_CUTOVER_NOT_READY com { code, detail }.
 */
async function rollbackSimulated(tenant, transaction) {
  let report;
  try { report = JSON.parse(fs.readFileSync(exportPath(tenant.companyId), 'utf8')); } catch (err) { return gap(err.code === 'ENOENT' ? 'NO_FILE' : 'UNREADABLE'); }
  const signed = verify(report);
  if (!signed.ok) return gap(signed.reason, report);
  if (report.conclusion !== 'APROVADO') return gap('NOT_APPROVED', report);
  const criterion = report.criteria && report.criteria.rollback_simulated;
  if (!criterion || criterion.ok !== true) return gap('NOT_SIMULATED', report);
  const problem = await bindingProblem(report, tenant, transaction);
  if (!problem) return [];
  const { reason, ...numbers } = problem;
  return gap(reason, report, numbers);
}

/** Registro explícito no ponto de extensão do GO (idempotente); chamado pela montagem das rotas, não por efeito colateral de import. */
const install = () => readiness.register(NAME, rollbackSimulated);

module.exports = { rollbackSimulated, install, GAP, NAME };
