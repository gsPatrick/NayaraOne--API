'use strict';

const { Rule, RuleVersion } = require('../../models');
const AppError = require('../../utils/AppError');
const { registrarAuditoria } = require('../../engines/audit/auditLog.service');
const {
  resolveEligibilityConfig,
  publishProviderEligibilityVersion,
  RULE_CODE: ELIGIBILITY_RULE_CODE,
  PRODUCTS,
  PRODUCT_LABEL,
} = require('./eligibility.service');
const {
  resolveCommissionSplit,
  publishCommissionSplitVersion,
  RULE_CODE: COMMISSION_RULE_CODE,
  DEFAULT_ACTION: COMMISSION_DEFAULT_ACTION,
  TRIGGER_EVENT_LABEL,
} = require('./commissionSplit.service');
const { evaluateRule } = require('../../engines/rules/rulesEngine');

const PROVIDERS = ['sandbox', 'manual'];
const PURPOSES = ['RESIDENCIAL', 'COMERCIAL'];

function bad(message) {
  return AppError.badRequest(message, 'CORRESPONDENT_PARAMETERS_VALIDATION');
}

function percent(value, label, { min = 0, max = 100, exclusiveMin = false } = {}) {
  const n = Number(value);
  if (value === null || value === undefined || value === '' || !Number.isFinite(n)) throw bad(`${label} precisa ser um número.`);
  if (n > max || n < min || (exclusiveMin && n <= min)) {
    throw bad(`${label} precisa estar ${exclusiveMin ? 'acima de' : 'entre'} ${min}% ${exclusiveMin ? 'e até' : 'e'} ${max}%.`);
  }
  return n;
}

function subset(list, allowed, label) {
  if (!Array.isArray(list) || list.length === 0) throw bad(`Selecione ao menos um item em ${label}.`);
  const unknown = list.filter((item) => !allowed.includes(item));
  if (unknown.length) throw bad(`${label}: valor(es) não reconhecido(s): ${unknown.join(', ')}.`);
  return Array.from(new Set(list));
}

function validateEligibility(input) {
  const allowedProviders = subset(input?.allowedProviders, PROVIDERS, 'Providers habilitados');
  const allowedPurposes = subset(input?.allowedPurposes, PURPOSES, 'Finalidades habilitadas');
  const allowedProducts = subset(input?.allowedProducts, PRODUCTS, 'Produtos habilitados');
  const maxAmountByProvider = {};
  for (const provider of PROVIDERS) {
    const raw = (input?.maxAmountByProvider || {})[provider];
    if (raw === null || raw === undefined || raw === '') {
      maxAmountByProvider[provider] = null;
    } else {
      const n = Number(raw);
      if (!Number.isFinite(n) || n <= 0) throw bad(`O teto de valor do provider "${provider}" precisa ser um número positivo (ou vazio, para sem teto).`);
      maxAmountByProvider[provider] = n;
    }
  }
  return { allowedProviders, allowedPurposes, allowedProducts, maxAmountByProvider };
}

function validateCommission(input) {
  const percentageByProvider = {};
  for (const provider of PROVIDERS) {
    percentageByProvider[provider] = percent((input?.percentageByProvider || {})[provider], `O percentual de comissão do provider "${provider}"`, { exclusiveMin: true });
  }
  const defaultPercentage = percent(input?.defaultPercentage, 'O percentual de comissão padrão', { exclusiveMin: true });
  const brokerSharePctByProvider = {};
  for (const provider of PROVIDERS) {
    brokerSharePctByProvider[provider] = percent((input?.brokerSharePctByProvider || {})[provider], `A parte do corretor do provider "${provider}"`);
  }
  const defaultBrokerSharePct = percent(input?.defaultBrokerSharePct, 'A parte do corretor padrão');
  const allowedTriggerEvents = subset(input?.allowedTriggerEvents, Object.keys(TRIGGER_EVENT_LABEL), 'Fatos geradores aceitos');
  const defaultTriggerEvent = input?.defaultTriggerEvent;
  if (!allowedTriggerEvents.includes(defaultTriggerEvent)) throw bad('O fato gerador padrão precisa estar entre os fatos geradores aceitos.');
  return { percentageByProvider, defaultPercentage, brokerSharePctByProvider, defaultBrokerSharePct, allowedTriggerEvents, defaultTriggerEvent };
}

async function history(code, groupId, companyId, transaction) {
  const rule = await Rule.findOne({ where: { code, groupId, companyId }, transaction });
  if (!rule) return [];
  const versions = await RuleVersion.findAll({ where: { ruleId: rule.id }, order: [['versionNumber', 'DESC']], limit: 20, transaction });
  return versions.map((v) => ({
    id: v.id,
    versionNumber: v.versionNumber,
    effectiveFrom: v.effectiveFrom,
    effectiveUntil: v.effectiveUntil,
    action: v.actionJson,
  }));
}

/**
 * getParameters — devolve a configuração vigente (semeando o padrão no primeiro uso) e o histórico
 * de versões das duas regras do correspondente: elegibilidade e comissão.
 */
async function getParameters(groupId, companyId, actorUserId, transaction) {
  const eligibility = await resolveEligibilityConfig(groupId, companyId, transaction, actorUserId);
  await resolveCommissionSplit('manual', groupId, companyId, actorUserId, transaction);
  const commission = await evaluateRule(COMMISSION_RULE_CODE, { commissionSplitActive: true }, { groupId, companyId }, { transaction });
  return {
    options: {
      providers: PROVIDERS,
      purposes: PURPOSES,
      products: PRODUCTS.map((value) => ({ value, label: PRODUCT_LABEL[value] })),
      triggerEvents: Object.keys(TRIGGER_EVENT_LABEL).map((value) => ({ value, label: TRIGGER_EVENT_LABEL[value] })),
    },
    eligibility: {
      ruleVersionId: eligibility.ruleVersionId,
      action: { allowedProducts: PRODUCTS, ...eligibility.action },
      history: await history(ELIGIBILITY_RULE_CODE, groupId, companyId, transaction),
    },
    commission: {
      ruleVersionId: commission.ruleVersionId,
      action: { ...COMMISSION_DEFAULT_ACTION, ...commission.action },
      history: await history(COMMISSION_RULE_CODE, groupId, companyId, transaction),
    },
  };
}

async function updateEligibility(input, reason, actorUserId, groupId, companyId, transaction) {
  const validated = validateEligibility(input);
  if (!reason || String(reason).trim().length < 3) throw bad('Informe o motivo da alteração (mínimo 3 caracteres).');
  const before = await resolveEligibilityConfig(groupId, companyId, transaction, actorUserId);
  // Regiões por provider não são editadas nesta tela: a regra vigente continua valendo.
  const action = before.action.allowedStatesByProvider
    ? { ...validated, allowedStatesByProvider: before.action.allowedStatesByProvider }
    : validated;
  const version = await publishProviderEligibilityVersion(groupId, companyId, action, actorUserId, transaction);
  await registrarAuditoria(
    {
      groupId,
      companyId,
      actorUserId,
      action: 'correspondent.parameters.eligibility.update',
      entityType: 'Rule',
      entityId: version.ruleId,
      beforeJson: before.action,
      afterJson: action,
      reason: `Parâmetros de elegibilidade alterados (versão ${version.versionNumber}): ${String(reason).trim()}`,
    },
    transaction
  );
  return { versionId: version.id, versionNumber: version.versionNumber, action };
}

async function updateCommission(input, reason, actorUserId, groupId, companyId, transaction) {
  const action = validateCommission(input);
  if (!reason || String(reason).trim().length < 3) throw bad('Informe o motivo da alteração (mínimo 3 caracteres).');
  await resolveCommissionSplit('manual', groupId, companyId, actorUserId, transaction);
  const current = await evaluateRule(COMMISSION_RULE_CODE, { commissionSplitActive: true }, { groupId, companyId }, { transaction });
  const version = await publishCommissionSplitVersion(groupId, companyId, action, actorUserId, transaction);
  await registrarAuditoria(
    {
      groupId,
      companyId,
      actorUserId,
      action: 'correspondent.parameters.commission.update',
      entityType: 'Rule',
      entityId: version.ruleId,
      beforeJson: current.action,
      afterJson: action,
      reason: `Parâmetros de comissão alterados (versão ${version.versionNumber}): ${String(reason).trim()}`,
    },
    transaction
  );
  return { versionId: version.id, versionNumber: version.versionNumber, action };
}

module.exports = { getParameters, updateEligibility, updateCommission, validateEligibility, validateCommission, PROVIDERS, PURPOSES };
