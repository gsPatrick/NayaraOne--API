'use strict';

const crypto = require('node:crypto');
const outbox = require('../../../engines/events/outbox');

/**
 * Eventos internos das seguradoras (M9-D238 3.2 e 3.4), publicados no outbox na MESMA transação do dado. São iguais para o caminho por API e para o fluxo manual: a única
 * diferença é `source` (API ou MANUAL). Só ids, datas e números de negócio: nenhum dado pessoal. A idempotência é pela chave de cada fato (nunca duplica ao reexecutar).
 */
const AGGREGATE = 'InsurancePolicy';

function publish(policy, eventType, key, payload, transaction) {
  return outbox.publishDomainEvent({
    groupId: policy.groupId, companyId: policy.companyId, aggregateType: AGGREGATE, aggregateId: policy.id, eventType,
    payload: { policyId: policy.id, ...payload }, idempotencyKey: `${eventType}:${key}`,
  }, transaction);
}

/** Cotação recebida da seguradora (pela API ou por tarefa manual). `ref`: o identificador do fato (cotação externa, envio ou tarefa). */
const shortRef = (ref) => crypto.createHash('sha256').update(String(ref)).digest('hex').slice(0, 24); // a chave de idempotência do outbox tem até 128 caracteres
const publishQuoteReceived = (policy, { ref, source, premiumAmount, renewal }, transaction) => publish(policy, renewal ? 'insurance.renewal.quote_received' : 'insurance.quote.received', `${policy.id}:${shortRef(ref)}`, { source, premiumAmount: premiumAmount === undefined ? null : premiumAmount, renewal: Boolean(renewal) }, transaction);

/** Apólice emitida (proposta aceita e documento da apólice). Uma vez por apólice. */
const publishPolicyIssued = (policy, { source, policyNumber }, transaction) => publish(policy, 'insurance.policy.issued', policy.id, { source, policyNumber: policyNumber || null, effectiveDate: policy.effectiveDate, expiryDate: policy.expiryDate }, transaction);

/** Marco de vencimento (60, 30, 15 ou 7 dias, conforme o parâmetro): uma vez por apólice, por marco e por vigência. */
const expiringKey = (policy, marco) => `insurance.policy.expiring:${policy.id}:${policy.expiryDate}:${marco}`;
const publishPolicyExpiring = (policy, { marco, daysToExpiry }, transaction) => publish(policy, 'insurance.policy.expiring', `${policy.id}:${policy.expiryDate}:${marco}`, { marco, daysToExpiry, expiryDate: policy.expiryDate }, transaction);

/** Vigência encerrada (no dia seguinte ao fim): uma vez por apólice e vigência. */
const publishPolicyExpired = (policy, transaction) => publish(policy, 'insurance.policy.expired', `${policy.id}:${policy.expiryDate}`, { expiryDate: policy.expiryDate }, transaction);

/** Nova versão do documento da apólice (endosso ou renovação). */
const publishVersionAdded = (policy, version, transaction) => publish(policy, 'insurance.policy.version_added', `${policy.id}:${version.version}`, { version: version.version, kind: version.kind, source: version.source, sha256: version.sha256, effectiveFrom: version.effectiveFrom }, transaction);

module.exports = { publishQuoteReceived, publishPolicyIssued, expiringKey, publishPolicyExpiring, publishPolicyExpired, publishVersionAdded };
