'use strict';

const { PaymentIntent, IntegrationDispatch, sequelize } = require('../../../../../models');
const contingency = require('../../../../../features/integrations/contingency/contingency.domainHooks');
const { resolveDomainAssignee } = require('../../../../../features/integrations/contingency/contingency.assignee');
const { registerPreflight } = require('../../../../../features/integrations/dispatch/worker/worker.hooks');
const { PAYMENT_AGGREGATE } = require('./bank.constants');

const MARKER = 'CONTINGENCY_QUERY_FIRST';
const DOMAIN = 'BANK';
const PAPEL_PADRAO = 'Financeiro';

/**
 * Banco fora, o que a contingência faz com o DINHEIRO (M9-D228 3.1, modo NO_ASSUME_AND_QUERY). O pagamento nunca é dado como pago por presunção: a ordem que esperou na fila
 * (PENDING ou RETRY_WAIT) e a que ficou incerta (UNKNOWN ou SUBMITTED sem status final) contam no prazo `integration.bank.max_pending_hours` (72 h), passado o qual sai UMA tarefa ao
 * financeiro para conferir no internet banking. Ao voltar o banco, ANTES de qualquer reenvio, cada ordem solta pela fila é CONSULTADA pela chave de idempotência e pelo extrato
 * (reconciliação da M9-D215): achada, vira o que o banco diz; inexistente, só então sai de novo com a MESMA chave; inconclusiva, fica UNKNOWN para uma pessoa.
 */

/** Marca as ordens de pagamento soltas pela fila: o worker as manda para UNKNOWN antes da chamada, e a reconciliação consulta o banco. */
async function markQueryFirst(ctx, { ids }, transaction) {
  if (!ids || !ids.length) return 0;
  const [, meta] = await sequelize.query(
    `UPDATE "integration"."dispatches" SET last_error_code = :marker
      WHERE company_id = :companyId AND id IN (:ids) AND aggregate_type = :aggregate AND operation = 'submitPayment' AND status IN ('PENDING', 'RETRY_WAIT')`,
    { replacements: { marker: MARKER, companyId: ctx.companyId, ids, aggregate: PAYMENT_AGGREGATE }, transaction },
  );
  return meta && meta.rowCount ? meta.rowCount : 0;
}

/** Antes de gastar a tentativa: a ordem marcada vai a UNKNOWN (sem reenviar) e a consulta pela chave decide o que acontece com ela. */
async function queryFirstPreflight({ dispatch }) {
  if (dispatch.aggregateType !== PAYMENT_AGGREGATE || dispatch.operation !== 'submitPayment' || dispatch.lastErrorCode !== MARKER) return null;
  return { unknown: true, reason: MARKER };
}

/** Tarefa ao financeiro: conferir no internet banking e localizar a evidência; o pagamento só é dado como pago com ela. Só ids e valor, sem dado do favorecido. */
async function buildBankTask(event, transaction) {
  const p = event.payloadJson || {};
  const ctx = { groupId: event.groupId, companyId: event.companyId };
  const envio = p.dispatchId ? await IntegrationDispatch.findOne({ where: { id: p.dispatchId, companyId: ctx.companyId }, transaction }) : null;
  const intent = envio && envio.aggregateType === PAYMENT_AGGREGATE ? await PaymentIntent.findByPk(envio.aggregateId, { transaction }) : null;
  const valor = intent && intent.snapshotJson && intent.snapshotJson.amount !== undefined ? ` de R$ ${intent.snapshotJson.amount}` : '';
  const quem = intent ? `a intenção de pagamento ${intent.id}${valor}` : `o envio ${p.dispatchId}`;
  return {
    assignedToUserId: await resolveDomainAssignee(ctx, 'integration.bank.manual_task_assignee_role', PAPEL_PADRAO, transaction),
    title: 'Conferir no internet banking o pagamento pendente',
    description: `Conferir no internet banking ${quem}, pendente há ${p.ageHours} h, e localizar a evidência: o status final do banco ou a entrada do extrato conciliada. Nada é dado como pago sem essa evidência e nenhuma nova ordem deve ser criada antes da conferência.`,
  };
}

let installed = false;
function installBankContingency() {
  if (installed) return;
  installed = true;
  contingency.registerAgedStatuses(DOMAIN, ['UNKNOWN', 'SUBMITTED']);
  contingency.registerManualTaskBuilder(DOMAIN, buildBankTask);
  contingency.registerDrained(DOMAIN, markQueryFirst);
  registerPreflight(queryFirstPreflight);
}

module.exports = { installBankContingency, markQueryFirst, queryFirstPreflight, buildBankTask, MARKER };
