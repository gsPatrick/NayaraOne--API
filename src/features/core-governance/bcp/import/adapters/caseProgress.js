'use strict';

const { FinancingCase, ProviderStatusHistory } = require('../../../../../models');
const { registerManualStatus, MANUAL_STATUSES } = require('../../../../correspondent/cases/caseWorkflow.service');
const { CASE_STATUS_LABEL } = require('../../../../correspondent/correspondentCatalog');
const { resolveRef } = require('../refs');
const { commandRejected } = require('../../bcp.errors');
const normalize = require('../normalize');

/** A etapa escrita no papel -> um dos resultados manuais do caso (pelo código ou pelo nome em português); outro texto recusa o comando. */
function statusOf(stage) {
  const wanted = normalize.text(stage);
  const found = MANUAL_STATUSES.find((code) => normalize.text(code) === wanted || normalize.text(CASE_STATUS_LABEL[code]) === wanted);
  if (!found) throw commandRejected(`a etapa "${stage}" não é um andamento reconhecido (use: ${MANUAL_STATUSES.map((code) => CASE_STATUS_LABEL[code]).join(', ')})`);
  return found;
}

/**
 * REGISTER_CASE_PROGRESS: o andamento do papel é registrado no processo de financiamento pelo serviço normal do Correspondente (resultado manual, que mantém todas as regras
 * de ordem e de provider manual). Confere processo, etapa e data do registro.
 */
async function execute({ tenant, actorUserId, operation, payload, transaction }) {
  const financingCase = await resolveRef('financingCase', payload.processo, tenant, transaction);
  const status = statusOf(payload.etapa);
  const note = `Origem BCP ${operation.manualReference}. Situação: ${payload.situacao}.${payload.observacao ? ` ${payload.observacao}` : ''}`.slice(0, 480);
  await registerManualStatus(financingCase.id, { status, note }, actorUserId, tenant.groupId, tenant.companyId, transaction, { canCorrect: false });
  const saved = await FinancingCase.findByPk(financingCase.id, { transaction });
  const history = await ProviderStatusHistory.findOne({ where: { financingCaseId: saved.id, normalizedStatus: status }, order: [['occurredAt', 'DESC']], transaction });
  return {
    commandRef: `FinancingCase:${saved.id}`,
    undo: { financingCaseId: saved.id, historyId: history ? history.id : null },
    comparisons: [
      { field: 'processo', label: 'Processo', paper: normalize.id(financingCase.id), command: normalize.id(saved.id), kind: 'ref' },
      { field: 'etapa', label: 'Etapa', paper: status, command: saved.status, kind: 'text' },
      { field: 'data', label: 'Data do andamento', paper: normalize.day(payload.data), command: normalize.day(history && history.occurredAt), kind: 'date' },
    ],
  };
}

async function reverse() {
  throw commandRejected('o andamento fica no histórico do processo e não tem estorno; aceite a divergência ou corrija o resultado pelo módulo do Correspondente');
}

module.exports = { action: 'REGISTER_CASE_PROGRESS', execute, reverse, statusOf };
