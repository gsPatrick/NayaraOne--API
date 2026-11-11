'use strict';

/**
 * Regra de aprovação do pagamento (Caderno §2 FIN-005 "Limites vêm do Motor de Regras; aprovação usa snapshot/hash"; Guia §1.6 e §4
 * `rules.evaluate('REG-FIN-002', ctx, { finance: { amount, categoryCode } })` + `approvals.createFromRule`; Caderno §8 passos 3, 5 e 6).
 *
 * O nível de risco e o número de aprovadores NUNCA vêm do pedido: saem da versão publicada da regra REG-FIN-002 (ação `riskLevel` e,
 * opcional, `requiredApprovals`) e, quando a regra não define o risco (não publicada, condição não atendida ou ação sem `riskLevel`),
 * dos parâmetros pagamentos.faixa.* / pagamentos.aprovadores.* (DEC-004). MFA na aprovação: HIGH e CRITICAL sempre; MEDIUM conforme
 * pagamentos.mfa.aprovacao_medio (DEC-058).
 */
const { evaluateRule } = require('../../../../engines/rules/rulesEngine');
const { ChartOfAccount } = require('../../../../models');
const { readPaymentBands } = require('./payment-approval-settings');
const { toCents, centsText } = require('../../domain/payment-intent');

const RULE_CODE = 'REG-FIN-002';
const RISK_LEVELS = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];

/** Risco pelas faixas de valor (centavos inteiros, sem ponto flutuante). */
function riskFromBands(amountCents, bands) {
  const limit = (v) => toCents(Number(v).toFixed(2));
  if (amountCents <= limit(bands.lowUpTo)) return 'LOW';
  if (amountCents <= limit(bands.mediumUpTo)) return 'MEDIUM';
  if (amountCents <= limit(bands.highUpTo)) return 'HIGH';
  return 'CRITICAL';
}

function validApprovals(value) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= 5 ? n : null;
}

async function categoryCodeOf(entry, transaction) {
  if (!entry || !entry.chartOfAccountId) return null;
  const account = await ChartOfAccount.findByPk(entry.chartOfAccountId, { transaction });
  return account ? account.code : null;
}

/**
 * resolvePaymentApprovalPolicy — { riskLevel, requiredApprovals, ruleVersionId, riskSource, mfaRequired } para pagar `amountCents`
 * do lançamento `entry`. `riskSource` = RULE (versão publicada da REG-FIN-002) ou PARAMETERS (faixas da DEC-004).
 */
async function resolvePaymentApprovalPolicy(entry, amountCents, tenant, transaction) {
  const bands = await readPaymentBands(tenant, transaction);
  const categoryCode = await categoryCodeOf(entry, transaction);
  const evaluation = await evaluateRule(RULE_CODE, { finance: { amount: centsText(amountCents), categoryCode } }, tenant, { transaction });
  const action = evaluation.decision === 'APPLY' && evaluation.action ? evaluation.action : {};
  const ruleRisk = RISK_LEVELS.includes(String(action.riskLevel || '').toUpperCase()) ? String(action.riskLevel).toUpperCase() : null;

  const riskLevel = ruleRisk || riskFromBands(amountCents, bands);
  const requiredApprovals = (ruleRisk && validApprovals(action.requiredApprovals)) || bands.approvers[riskLevel];
  return {
    riskLevel,
    requiredApprovals,
    ruleVersionId: ruleRisk ? evaluation.ruleVersionId : null,
    riskSource: ruleRisk ? 'RULE' : 'PARAMETERS',
    mfaRequired: riskLevel === 'HIGH' || riskLevel === 'CRITICAL' || (riskLevel === 'MEDIUM' && bands.mfaOnMedium),
    categoryCode,
  };
}

/** MFA exigido na aprovação para o risco informado (risco já gravado no pedido). */
async function approvalRequiresMfa(riskLevel, tenant, transaction) {
  if (riskLevel === 'HIGH' || riskLevel === 'CRITICAL') return true;
  if (riskLevel !== 'MEDIUM') return false;
  return (await readPaymentBands(tenant, transaction)).mfaOnMedium;
}

module.exports = { RULE_CODE, RISK_LEVELS, riskFromBands, resolvePaymentApprovalPolicy, approvalRequiresMfa };
