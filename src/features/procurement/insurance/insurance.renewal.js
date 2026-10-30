'use strict';

const { IntegrationDispatch, Notification } = require('../../../models');
const { Op } = require('sequelize');
const { registrarAuditoria } = require('../../../engines/audit/auditLog.service');
const { callInsurer, retryKey } = require('./insurance.call');
const { quoteFromResponse } = require('./insurance.domain');
const { publishQuoteReceived } = require('./insurance.events');

const LIVE = ['PENDING', 'SENDING', 'SUBMITTED', 'CONFIRMED', 'UNKNOWN', 'RETRY_WAIT'];

/**
 * Cotação de renovação (M9-D238 3.4: "a renovação inicia nova cotação pelo mesmo adapter"). Pede ao mesmo fornecedor (API ou fluxo manual) a cotação com o pedido da cotação
 * original, uma vez por apólice e vigência (a chave leva o fim da vigência). Resposta da API: aviso à pessoa responsável e evento `insurance.renewal.quote_received`; sem API,
 * tarefa manual com finalidade RENEWAL. Falha da seguradora nunca derruba a rotina: fica na auditoria e a próxima rodada tenta de novo. Devolve { started, reason? }.
 */
async function startRenewalQuote(policy, transaction) {
  const base = `insurance-renewal-quote:${policy.id}:${String(policy.expiryDate).slice(0, 10)}`;
  const ctx = { groupId: policy.groupId, companyId: policy.companyId, userId: null };
  const jaPedida = await IntegrationDispatch.count({ where: { companyId: ctx.companyId, aggregateType: 'InsurancePolicy', aggregateId: policy.id, operation: 'quote', idempotencyKey: { [Op.like]: `${base}%` }, status: LIVE }, transaction });
  if (jaPedida > 0) return { started: false, reason: 'ALREADY_REQUESTED' };
  const pedido = policy.quoteRequestJson;
  if (!pedido || typeof pedido !== 'object') {
    await registrarAuditoria({ groupId: policy.groupId, companyId: policy.companyId, actorUserId: null, action: 'procurement.insurance_policy.renewal_quote_skipped', entityType: 'InsurancePolicy', entityId: policy.id, reason: 'A apólice não tem o pedido da cotação original: a cotação de renovação precisa ser pedida pela pessoa.' }, transaction);
    return { started: false, reason: 'NO_ORIGINAL_REQUEST' };
  }
  try {
    const chave = await retryKey(ctx, { base, operation: 'quote', aggregateType: 'InsurancePolicy', aggregateId: policy.id }, transaction);
    const call = await callInsurer({ ctx, policy, operation: 'quote', domainObject: { ...pedido, policyRef: policy.id, purposeKind: 'RENEWAL' }, idempotencyKey: chave, transaction });
    if (call.source === 'API') {
      const cotacao = quoteFromResponse(call.response);
      const premio = cotacao.premiumAmount === undefined || cotacao.premiumAmount === null ? null : Number(cotacao.premiumAmount);
      await publishQuoteReceived(policy, { ref: `${base}`, source: 'API', premiumAmount: premio, renewal: true }, transaction);
      if (policy.createdBy) {
        await Notification.create({ groupId: policy.groupId, companyId: policy.companyId, userId: policy.createdBy, channel: 'IN_APP', title: 'Cotação de renovação recebida', body: `A cotação de renovação da apólice ${policy.externalPolicyNumber || policy.id} chegou${premio === null ? '' : `: prêmio R$ ${premio.toFixed(2)}`}.` }, { transaction });
      }
    }
    await registrarAuditoria({ groupId: policy.groupId, companyId: policy.companyId, actorUserId: null, action: 'procurement.insurance_policy.renewal_quote', entityType: 'InsurancePolicy', entityId: policy.id, afterJson: { dispatchId: call.dispatch.id, source: call.source }, reason: `Cotação de renovação pedida à seguradora (${call.source === 'MANUAL' ? 'tarefa manual' : 'API'}).` }, transaction);
    return { started: true, source: call.source, dispatchId: call.dispatch.id };
  } catch (err) {
    await registrarAuditoria({ groupId: policy.groupId, companyId: policy.companyId, actorUserId: null, action: 'procurement.insurance_policy.renewal_quote_failed', entityType: 'InsurancePolicy', entityId: policy.id, afterJson: { code: err.code || null }, reason: 'A cotação de renovação não foi concluída; a próxima rodada tenta de novo.' }, transaction);
    return { started: false, reason: 'PROVIDER_ERROR', code: err.code || null };
  }
}

module.exports = { startRenewalQuote };
