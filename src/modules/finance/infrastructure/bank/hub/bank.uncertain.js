'use strict';

const { sequelize, IntegrationDispatch, IntegrationConnection } = require('../../../../../models');
const adapterRegistry = require('../../../../../features/integrations/registry/adapterRegistry');
const { invoke } = require('../../../../../features/integrations/registry/adapterInvoke');
const { reconcileDispatch } = require('../../../../../features/integrations/dispatch/reconcile');
const { callBankSubmit, dispatchOf, sentResultOf } = require('./bank.dispatch');
const { configuredProviderKey, ensureBankConnection } = require('./bank.connection');
const { ensureBankAdaptersRegistered } = require('./bank.boot');

const ctxOf = (intent) => ({ groupId: intent.groupId, companyId: intent.companyId, userId: null });

/**
 * Resolve a ordem incerta (SUBMITTING) SEM reenviar às cegas (M9-D237 3.3 item 2, M9-D215): se o envio já saiu pelo worker, devolve o resultado dele; se está UNKNOWN, a
 * reconciliação consulta o banco pela chave e pelo id; só quando o banco AFIRMA que não existe a ordem sai de novo, com a MESMA chave. Devolve o mesmo formato de callBankSubmit.
 */
async function resolveUncertainSubmission(intent, transaction) {
  const ctx = ctxOf(intent);
  let dispatch = await dispatchOf(ctx, intent.id, transaction);
  if (!dispatch) return callBankSubmit({ intent, transaction });
  let pronto = await sentResultOf(ctx, intent.id, transaction);
  if (pronto) return pronto;
  if (dispatch.status === 'UNKNOWN') {
    await reconcileDispatch(ctx, dispatch.id, { transaction });
    dispatch = await IntegrationDispatch.findByPk(dispatch.id, { transaction });
    pronto = await sentResultOf(ctx, intent.id, transaction);
    if (pronto) return pronto;
  }
  if (['PENDING', 'RETRY_WAIT'].includes(dispatch.status)) return callBankSubmit({ intent, transaction });
  return { ok: false, error: `A ordem ao banco segue incerta (${dispatch.status}): a reconciliação aguarda uma resposta conclusiva do banco.` };
}

/** Consulta o status do pagamento no banco, pelo registro de integrações. Devolve { status, amount } com o status normalizado e o valor que o banco informa (ou null). */
async function queryPaymentStatus(intent, transaction) {
  ensureBankAdaptersRegistered();
  const ctx = ctxOf(intent);
  const dispatch = await dispatchOf(ctx, intent.id, transaction);
  const connection = dispatch
    ? await IntegrationConnection.findOne({ where: { id: dispatch.connectionId, companyId: ctx.companyId }, transaction })
    : await ensureBankConnection(ctx, await configuredProviderKey(ctx, transaction), transaction);
  const adapter = await adapterRegistry.resolve(connection, ctx, transaction);
  /** @type {any} */
  let bruta = null;
  const r = await sequelize.transaction({ transaction }, () => invoke(adapter, 'getPaymentStatus', { externalResourceId: intent.externalSubmissionId }, {
    tenant: ctx, transaction, meta: { reconcile: true }, onResponse: (x) => { bruta = x; },
  }));
  return { status: r.status, amount: bruta && bruta.amount !== undefined ? bruta.amount : null, sandbox: connection.providerCode === 'bank-sandbox' };
}

module.exports = { resolveUncertainSubmission, queryPaymentStatus };
