'use strict';

const { InsuranceManualTask } = require('../../../models');

const clean = (obj) => Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined && v !== null && v !== ''));

/**
 * Objeto de domínio do pedido de cotação (M9-D238): o que o mapper `insurance.quote` aceita. `providerRequest` leva o corpo que a pessoa informou, com os campos que só a seguradora
 * escolhida entende; o valor segurado e o tipo do imóvel vão em campos próprios, para o sandbox e o fluxo manual. Nenhuma entidade ou DTO da API.
 */
function quoteDomainObject(policy, quoteRequest) {
  const q = quoteRequest || {};
  return clean({
    policyRef: policy.id, insuredAmount: Number(q.estimatedValue), propertyType: q.propertyType, insuredName: q.insuredName, insuredDocument: q.insuredDocument, providerRequest: q,
  });
}

/** Objeto de domínio da proposta: o que o mapper `insurance.propose` aceita. O corpo da emissão (com os campos próprios da seguradora) vai em `providerRequest`. */
function proposeDomainObject(policy, issueRequest, { effectiveDate, expiryDate }) {
  return clean({
    policyRef: policy.id, premiumAmount: policy.premiumAmount === null || policy.premiumAmount === undefined ? undefined : Number(policy.premiumAmount), effectiveDate: effectiveDate && String(effectiveDate).slice(0, 10),
    expiryDate: expiryDate && String(expiryDate).slice(0, 10), installmentsCount: issueRequest && issueRequest.installmentsCount, providerRequest: issueRequest || undefined,
  });
}

/** Objeto de domínio do sinistro: o que o mapper `insurance.submitClaim` aceita. */
function claimDomainObject(claim, policy) {
  return clean({ claimRef: claim.id, externalPolicyNumber: policy && policy.externalPolicyNumber, description: claim.description, claimAmount: claim.claimAmount === null || claim.claimAmount === undefined ? undefined : Number(claim.claimAmount) });
}

/** A cotação que a regra de negócio aplica, tirada da resposta do adapter: prêmio, cobertura, identificador e a resposta completa da seguradora (`raw`, que nunca sai do módulo de integrações). */
function quoteFromResponse(response) {
  const r = (response && response.raw) || {};
  const q = (response && response.quote) || {};
  return { premiumAmount: q.premiumAmount ?? r.premiumAmount, coverageSummary: q.coverageSummary ?? r.coverageSummary, externalId: r.externalId || (response && response.externalResourceId) || null, raw: r.raw };
}

/** A tarefa manual aberta pelo pedido (id, tipo e prazo), para a resposta da cotação ou da emissão sem API. */
async function pendingTaskOf(response, transaction) {
  const id = response && response.task && response.task.id;
  const task = id ? await InsuranceManualTask.findByPk(id, { transaction }) : null;
  return task ? { id: task.id, kind: task.kind, status: task.status, dueAt: task.dueAt, assignedToUserId: task.assignedToUserId } : null;
}

/**
 * Resposta incerta da seguradora (proposta ou sinistro): o pedido NÃO foi desfeito nem repetido. O envio segue UNKNOWN, gravado, e a reconciliação pela chave de idempotência (M9-D215)
 * descobre se a seguradora executou; pedir de novo com a mesma chave devolve o mesmo envio. Quem responde ao usuário usa 202.
 */
const providerResultOf = (call) => ({
  state: 'UNCERTAIN', dispatchId: call.dispatch.id, dispatchStatus: call.dispatch.status,
  message: 'A seguradora não respondeu a tempo: o resultado do pedido é incerto. Confira com a seguradora antes de repetir; o pedido segue com a mesma chave, sem duplicar.',
});

module.exports = { quoteDomainObject, proposeDomainObject, claimDomainObject, quoteFromResponse, pendingTaskOf, providerResultOf };
