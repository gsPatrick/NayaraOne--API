'use strict';

const { sequelize, IntegrationDispatch, Person, BankAccount } = require('../../../models');
require('../../integrations/dispatch'); // fachada do Dispatch Service: registra a política de nova tentativa e a reconciliação do envio incerto (D215 e D216)
const dispatchService = require('../../integrations/dispatch/enqueue/dispatch.service');
const { transitionDispatch } = require('../../integrations/dispatch/dispatch.transition');
const { processClaimed } = require('../../integrations/dispatch/worker/worker.process');
const { tenantTx } = require('../../integrations/dispatch/worker/tenantTx');
const { ensureBankConnection, configuredProviderKey } = require('./bank.connection');
const { buildPaymentDomainObject } = require('./bank.payload');
const { PAYMENT_AGGREGATE } = require('./bank.constants');
const { ensureBankAdaptersRegistered } = require('./bank.boot');

/**
 * O pagamento passa pelo Dispatch Service (M9-D237 3.2): a ordem nasce em integration.dispatches (`enqueue`, conteúdo minimizado pelo mapper bank.submitPayment,
 * chave de idempotência = a da intenção, classe DANGEROUS e confirmação ON_STATUS) e a chamada ao banco sai pelo worker de envios (circuito, cota e nova tentativa
 * do framework). HTTP 200/202 do banco deixa o envio em SUBMITTED; só o status final assinado ou consultado o confirma (bank.confirm).
 */
const runner = (ctx, transaction) => (fn) => (transaction ? sequelize.transaction({ transaction }, fn) : tenantTx(ctx, fn));

async function ownerDocumentOf(intent, transaction) {
  const conta = intent.bankAccountId ? await BankAccount.findByPk(intent.bankAccountId, { transaction }) : null;
  const pessoa = conta && conta.ownerPersonId ? await Person.findByPk(conta.ownerPersonId, { transaction }) : null;
  return pessoa ? pessoa.taxIdNormalized || null : null;
}

/** O envio da intenção (o mais recente), ou null. */
const dispatchOf = (ctx, intentId, transaction) => IntegrationDispatch.findOne({
  where: { companyId: ctx.companyId, aggregateType: PAYMENT_AGGREGATE, aggregateId: intentId }, order: [['created_at', 'DESC']], transaction,
});

/**
 * Entrega a ordem ao banco. Devolve { ok:true, externalId, status } (o banco aceitou: SUBMITTED), { deferred } (circuito aberto, conexão parada ou cota: nada foi enviado e a
 * ordem fica reagendada no worker) ou { ok:false, error } (falha ou resposta incerta: o envio fica UNKNOWN/RETRY_WAIT e se resolve por consulta pela chave).
 * Nunca lança. `args`: intent, transaction (opcional: roda tudo nela, em savepoints).
 */
async function callBankSubmit({ intent, transaction }) {
  const ctx = { groupId: intent.groupId, companyId: intent.companyId, userId: intent.updatedBy || null };
  const run = runner(ctx, transaction);
  try {
    ensureBankAdaptersRegistered();
    let dispatch = await run((t) => dispatchOf(ctx, intent.id, t));
    if (!dispatch) {
      const providerKey = await run((t) => configuredProviderKey(ctx, t));
      ({ dispatch } = await run(async (t) => {
        const connection = await ensureBankConnection(ctx, providerKey, t);
        return dispatchService.enqueue({
          companyId: ctx.companyId, connectionId: connection.id, operation: 'submitPayment', aggregateType: PAYMENT_AGGREGATE, aggregateId: intent.id,
          payload: buildPaymentDomainObject(intent, { ownerDocument: await ownerDocumentOf(intent, t) }), idempotencyKey: intent.idempotencyKey, userId: ctx.userId, transaction: t,
        });
      }));
    }
    return await deliver(ctx, dispatch, run, transaction);
  } catch (error) {
    return { ok: false, error: error && error.message ? error.message : String(error) };
  }
}

/** Pega o envio na fila (se está esperando) e roda a chamada pelo worker; traduz o desfecho para o Financeiro. */
async function deliver(ctx, dispatch, run, transaction) {
  let atual = dispatch;
  if (['PENDING', 'RETRY_WAIT'].includes(atual.status)) {
    await run((t) => transitionDispatch(ctx, atual.id, 'SENDING', {}, { motivo: 'Envio pego pelo fluxo de pagamentos do Financeiro.' }, t));
    const r = await processClaimed(ctx, atual.id, { transaction });
    atual = await run((t) => IntegrationDispatch.findOne({ where: { id: atual.id, companyId: ctx.companyId }, transaction: t }));
    if (r.deferred) return { ok: false, deferred: true, error: 'Fornecedor temporariamente indisponível; a operação foi reagendada.', code: 'INTEGRATION_CIRCUIT_OPEN' };
  }
  if (['SUBMITTED', 'CONFIRMED'].includes(atual.status)) return { ok: true, externalId: atual.externalResourceId, status: atual.externalStatus, dispatchId: atual.id };
  if (atual.status === 'RETRY_WAIT' && atual.nextAttemptAt && atual.nextAttemptAt.getTime() > Date.now() + 1000) {
    return { ok: false, deferred: true, error: 'O banco pediu para esperar; a ordem foi reagendada.', code: 'INTEGRATION_CIRCUIT_OPEN', dispatchId: atual.id };
  }
  return { ok: false, error: `A ordem ao banco não foi concluída (${atual.status}${atual.lastErrorCode ? `: ${atual.lastErrorCode}` : ''}).`, dispatchId: atual.id };
}

/** Intenção SUBMITTING cujo envio já saiu (pelo worker, depois de reagendar): devolve o resultado do envio para o Financeiro finalizar. Null se ainda não saiu. */
async function sentResultOf(ctx, intentId, transaction) {
  const d = await dispatchOf(ctx, intentId, transaction);
  if (d && ['SUBMITTED', 'CONFIRMED'].includes(d.status) && d.externalResourceId) return { ok: true, externalId: d.externalResourceId, status: d.externalStatus, dispatchId: d.id };
  return null;
}

module.exports = { callBankSubmit, dispatchOf, sentResultOf };
