'use strict';

/**
 * Parâmetros da autorização financeira (pagamento, estorno e reabertura de período) que o administrador grava na aba "Financeiro" de
 * Configurações (PUT /settings/:key). O livro (Marco 4 §2 FIN-005 "Limites vêm do Motor de Regras", Guia §4 REG-FIN-002, §8 passo 6
 * "Step-up MFA para HIGH/CRITICAL", §16 "Reabertura requer permissão CRITICAL, MFA, motivo e auditoria") não traz os números: os padrões
 * são os da DEC-004 (faixas R$ 5.000 / R$ 50.000 / R$ 200.000, aprovadores 1/1/2/2, MFA no risco médio desligado), da DEC-003 (estorno
 * aprovado por outra pessoa, ligado) e do catálogo parametros.csv (motivo da reabertura com 20 caracteres). O número de pessoas que
 * aprovam a reabertura é a DI-M4PG-4. `requiresMfa` segue a coluna exige_mfa_para_alterar do catálogo.
 *
 * Os valores valem quando a versão publicada da regra REG-FIN-002 do Motor de Regras não define o risco (payment-approval-policy.js).
 */
const AppError = require('../../../../utils/AppError');
const { registerSettingGuard } = require('../../../../features/settings/settingGuards');

const KEYS = Object.freeze({
  lowUpTo: 'pagamentos.faixa.baixo_ate',
  mediumUpTo: 'pagamentos.faixa.medio_ate',
  highUpTo: 'pagamentos.faixa.alto_ate',
  approversLow: 'pagamentos.aprovadores.baixo',
  approversMedium: 'pagamentos.aprovadores.medio',
  approversHigh: 'pagamentos.aprovadores.alto',
  approversCritical: 'pagamentos.aprovadores.critico',
  mfaOnMediumApproval: 'pagamentos.mfa.aprovacao_medio',
  reversalDistinctApprover: 'financeiro.estorno.aprovador_distinto',
  reopenReasonMinChars: 'fechamento.reabertura_motivo_minimo_caracteres',
  reopenApprovers: 'fechamento.reabertura.aprovadores',
  riskWithoutAmount: 'pagamentos.risco_sem_valor',
});

const MONEY = { type: 'number', min: 0.01, max: 999999999.99, requiresMfa: true };
const APPROVERS = { type: 'integer', min: 1, max: 5, requiresMfa: true };

const PAYMENT_APPROVAL_SETTINGS_SCHEMA = Object.freeze({
  [KEYS.lowUpTo]: MONEY,
  [KEYS.mediumUpTo]: MONEY,
  [KEYS.highUpTo]: MONEY,
  [KEYS.approversLow]: APPROVERS,
  [KEYS.approversMedium]: APPROVERS,
  [KEYS.approversHigh]: APPROVERS,
  [KEYS.approversCritical]: APPROVERS,
  [KEYS.mfaOnMediumApproval]: { type: 'boolean', requiresMfa: true },
  [KEYS.reversalDistinctApprover]: { type: 'boolean', requiresMfa: true },
  [KEYS.reopenReasonMinChars]: { type: 'integer', min: 5, max: 500 },
  [KEYS.reopenApprovers]: { type: 'integer', min: 1, max: 5, requiresMfa: true },
  // DI-M4PG-2: pedido de aprovação de algo sem valor em dinheiro (dados de conta bancária).
  [KEYS.riskWithoutAmount]: { type: 'string', enum: ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'], requiresMfa: true },
});

const PAYMENT_APPROVAL_SETTINGS_DEFAULTS = Object.freeze({
  [KEYS.lowUpTo]: 5000,
  [KEYS.mediumUpTo]: 50000,
  [KEYS.highUpTo]: 200000,
  [KEYS.approversLow]: 1,
  [KEYS.approversMedium]: 1,
  [KEYS.approversHigh]: 2,
  [KEYS.approversCritical]: 2,
  [KEYS.mfaOnMediumApproval]: false,
  [KEYS.reversalDistinctApprover]: true,
  [KEYS.reopenReasonMinChars]: 20,
  [KEYS.reopenApprovers]: 1,
  [KEYS.riskWithoutAmount]: 'CRITICAL',
});

function getSettingLazy() {
  return require('../../../../features/settings/settings.service').getSetting; // leitura tardia: o dicionário de parâmetros carrega este arquivo
}

/** Número com o padrão do catálogo; valor gravado que não é número finito vira o padrão (falha segura). */
async function readNumber(key, tenant, transaction) {
  const fallback = PAYMENT_APPROVAL_SETTINGS_DEFAULTS[key];
  const value = Number(await getSettingLazy()(key, tenant, transaction, fallback));
  return Number.isFinite(value) ? value : fallback;
}

/** Booleano com o padrão do catálogo; qualquer coisa que não seja true/false explícito vira o padrão. */
async function readBoolean(key, tenant, transaction) {
  const fallback = PAYMENT_APPROVAL_SETTINGS_DEFAULTS[key];
  const value = await getSettingLazy()(key, tenant, transaction, fallback);
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  return fallback;
}

/** Texto de uma lista fechada; fora da lista vira o padrão. */
async function readOption(key, tenant, transaction) {
  const fallback = PAYMENT_APPROVAL_SETTINGS_DEFAULTS[key];
  const value = String(await getSettingLazy()(key, tenant, transaction, fallback) || '').toUpperCase();
  return PAYMENT_APPROVAL_SETTINGS_SCHEMA[key].enum.includes(value) ? value : fallback;
}

/** Faixas e aprovadores do pagamento, já com os padrões. */
async function readPaymentBands(tenant, transaction) {
  const [lowUpTo, mediumUpTo, highUpTo, low, medium, high, critical, mfaOnMedium] = await Promise.all([
    readNumber(KEYS.lowUpTo, tenant, transaction),
    readNumber(KEYS.mediumUpTo, tenant, transaction),
    readNumber(KEYS.highUpTo, tenant, transaction),
    readNumber(KEYS.approversLow, tenant, transaction),
    readNumber(KEYS.approversMedium, tenant, transaction),
    readNumber(KEYS.approversHigh, tenant, transaction),
    readNumber(KEYS.approversCritical, tenant, transaction),
    readBoolean(KEYS.mfaOnMediumApproval, tenant, transaction),
  ]);
  return { lowUpTo, mediumUpTo, highUpTo, approvers: { LOW: low, MEDIUM: medium, HIGH: high, CRITICAL: critical }, mfaOnMedium };
}

const invalid = (key, value, esperado) => AppError.badRequest(`O valor de "${key}" deve ser ${esperado}.`, 'SETTING_INVALID_VALUE', { key, value });

// Catálogo: "menor que o limite do risco médio" / "entre o limite baixo e o limite alto" / "maior que o limite médio".
const BAND_ORDER = [KEYS.lowUpTo, KEYS.mediumUpTo, KEYS.highUpTo];
const APPROVER_ORDER = [KEYS.approversLow, KEYS.approversMedium, KEYS.approversHigh, KEYS.approversCritical];

function registerOrderGuards(order, strict, label) {
  order.forEach((key, i) => {
    registerSettingGuard(key, async (value, tenant, _actor, transaction) => {
      const prev = i > 0 ? await readNumber(order[i - 1], tenant, transaction) : null;
      const next = i < order.length - 1 ? await readNumber(order[i + 1], tenant, transaction) : null;
      if (prev !== null && (strict ? value <= prev : value < prev)) throw invalid(key, value, `${strict ? 'maior que' : 'no mínimo'} ${prev} (${label} do risco anterior)`);
      if (next !== null && (strict ? value >= next : value > next)) throw invalid(key, value, `${strict ? 'menor que' : 'no máximo'} ${next} (${label} do risco seguinte)`);
    });
  });
}

registerOrderGuards(BAND_ORDER, true, 'o limite');
registerOrderGuards(APPROVER_ORDER, false, 'os aprovadores');

module.exports = {
  KEYS,
  PAYMENT_APPROVAL_SETTINGS_SCHEMA,
  PAYMENT_APPROVAL_SETTINGS_DEFAULTS,
  readNumber,
  readBoolean,
  readOption,
  readPaymentBands,
};
