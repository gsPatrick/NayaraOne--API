'use strict';

/**
 * Retrato e risco de um pedido de aprovação genérico (POST /finance/approval-requests — lançamento, comissão, parcela de comissão, repasse e
 * conta bancária). Caderno §2 FIN-005: "Limites vêm do Motor de Regras; aprovação usa snapshot/hash"; §5 approval_requests "Snapshot de
 * aprovação". O risco é calculado aqui (REG-FIN-002 ou faixas da DEC-004) a partir do valor da própria entidade, nunca lido do pedido; o
 * retrato são os campos da entidade sem os operacionais, e o hash dele é conferido na decisão.
 */
const { resolvePaymentApprovalPolicy, approvalRequiresMfa } = require('./payment-approval-policy');
const { KEYS, readOption, readPaymentBands } = require('./payment-approval-settings');
const { toCents, computeSnapshotHash } = require('../../domain/payment-intent');

// Valor em dinheiro que define o risco de cada tipo aprovável.
const AMOUNT_FIELD = Object.freeze({
  FinancialEntry: 'amount',
  Commission: 'totalAmount',
  CommissionInstallment: 'amount',
  OwnerRepass: 'netAmount',
});

// Campos que mudam sem mudar o significado do que se aprova (mesmo critério do retrato da intenção de pagamento).
const VOLATILE = new Set(['updatedAt', 'updated_at', 'createdAt', 'created_at', 'updatedBy', 'lockVersion', 'deletedAt', 'deleted_at']);

function buildEntitySnapshot(relatedEntityType, entity) {
  const raw = entity.toJSON ? entity.toJSON() : { ...entity };
  const snapshot = { relatedEntityType };
  for (const key of Object.keys(raw).sort()) {
    if (VOLATILE.has(key)) continue;
    const v = raw[key];
    snapshot[key] = v instanceof Date ? v.toISOString() : v === undefined ? null : v;
  }
  return snapshot;
}

function amountCentsOf(relatedEntityType, entity) {
  const field = AMOUNT_FIELD[relatedEntityType];
  if (!field) return null;
  const value = entity[field];
  if (value === null || value === undefined) return null;
  return toCents(String(value));
}

/** { riskLevel, requiredApprovals, ruleVersionId, riskSource, amountCents } — sem valor em dinheiro, o risco é o parâmetro pagamentos.risco_sem_valor. */
async function resolveSubjectPolicy(relatedEntityType, entity, tenant, transaction) {
  const amountCents = amountCentsOf(relatedEntityType, entity);
  if (amountCents === null) {
    const riskLevel = await readOption(KEYS.riskWithoutAmount, tenant, transaction);
    const bands = await readPaymentBands(tenant, transaction);
    return { riskLevel, requiredApprovals: bands.approvers[riskLevel], ruleVersionId: null, riskSource: 'PARAMETERS', amountCents: null };
  }
  const entry = relatedEntityType === 'FinancialEntry' ? entity : null;
  const policy = await resolvePaymentApprovalPolicy(entry, amountCents, tenant, transaction);
  return { ...policy, amountCents };
}

/** O retrato atual da entidade ainda é o aprovado? */
function snapshotStillMatches(request, relatedEntityType, entity) {
  if (!request.snapshotHash) return true; // pedido antigo (antes do retrato): vale a conferência por lock_version
  return computeSnapshotHash(buildEntitySnapshot(relatedEntityType, entity)) === request.snapshotHash;
}

module.exports = { AMOUNT_FIELD, buildEntitySnapshot, amountCentsOf, resolveSubjectPolicy, snapshotStillMatches, approvalRequiresMfa };
