'use strict';

const crypto = require('crypto');
const { Rule, RuleVersion, RuleScope, RulePublication, Property, sequelize } = require('../../models');
const AppError = require('../../utils/AppError');
const { registrarAuditoria } = require('../../engines/audit/auditLog.service');
const { evaluateRule } = require('../../engines/rules/rulesEngine');

/**
 * COR_PROVIDER_ELIGIBILITY — Marco 8 Fase 4 (Caderno: "Antes de simular/submeter, chamar Motor
 * de Regras COR_PROVIDER_ELIGIBILITY com produto, finalidade, valor, imóvel/região e provider.
 * Se não elegível, bloquear." / "Elegibilidade de provider vem do Motor de Regras; nenhum banco
 * é hard-coded como obrigatório."). Mesmo padrão arquitetural já usado por REG-EST-002
 * (adjustmentRiskRules.service.js): a regra guarda CONFIGURAÇÃO (quais providers, quais
 * finalidades, teto de valor por provider) no `actionJson`; a decisão de elegível/inelegível
 * para um caso concreto é aplicada aqui em código, usando essa configuração — nunca embutida
 * direto no AST da regra.
 */
const RULE_CODE = 'COR_PROVIDER_ELIGIBILITY';
const RULE_NAME = 'Elegibilidade de provider de financiamento (produto, finalidade, valor)';
const RULE_DOMAIN = 'correspondent';
const CONDITION_AST = { fact: 'eligibilityCheckActive', op: '==', value: true };

// Semente inicial — nenhum documento fonte define os números exatos ("elegibilidade conforme
// produto/finalidade/valor/provider" não traz limiares); usado só como valor padrão no primeiro
// uso do tenant. Depois de publicada, quem decide é a RuleVersion (editável via
// publishProviderEligibilityVersion, mesmo fluxo de REG-EST-002).
const DEFAULT_ACTION = {
  allowedProviders: ['sandbox', 'manual'],
  allowedPurposes: ['RESIDENCIAL', 'COMERCIAL'],
  // null = sem teto de valor para esse provider (ex.: "manual", workflow humano fora do sistema).
  maxAmountByProvider: { sandbox: 2000000, manual: null },
};

function hashCondition(conditionAstJson) {
  return crypto.createHash('sha256').update(JSON.stringify(conditionAstJson)).digest('hex');
}

async function getOrCreateRule(groupId, companyId, actorUserId, transaction) {
  let rule = await Rule.findOne({ where: { code: RULE_CODE, groupId, companyId }, transaction });
  if (!rule) {
    rule = await Rule.create(
      {
        groupId,
        companyId,
        code: RULE_CODE,
        name: RULE_NAME,
        description: 'Providers, finalidades e teto de valor por provider elegíveis para financiamento. Nenhum banco é hard-coded como obrigatório — tudo vem desta regra.',
        domain: RULE_DOMAIN,
        createdBy: actorUserId || null,
        updatedBy: actorUserId || null,
      },
      { transaction }
    );
  }
  return rule;
}

async function publishProviderEligibilityVersion(groupId, companyId, action, actorUserId, transaction) {
  const lockKey = `provider_eligibility_rule:${groupId}:${companyId}:${RULE_CODE}`;
  await sequelize.query('SELECT pg_advisory_xact_lock(hashtextextended(:lockKey, 0))', {
    replacements: { lockKey },
    transaction,
  });

  const rule = await getOrCreateRule(groupId, companyId, actorUserId, transaction);
  const now = new Date();

  await RuleVersion.update(
    { effectiveUntil: now, updatedBy: actorUserId || null },
    { where: { ruleId: rule.id, status: 'PUBLISHED', effectiveUntil: null }, transaction }
  );

  const lastVersion = await RuleVersion.findOne({ where: { ruleId: rule.id }, order: [['versionNumber', 'DESC']], transaction });
  const nextVersionNumber = lastVersion ? lastVersion.versionNumber + 1 : 1;

  const version = await RuleVersion.create(
    {
      groupId,
      companyId,
      ruleId: rule.id,
      versionNumber: nextVersionNumber,
      conditionAstJson: CONDITION_AST,
      contentHash: hashCondition(CONDITION_AST),
      actionJson: action,
      effectiveFrom: now,
      effectiveUntil: null,
      status: 'PUBLISHED',
      publishedByUserId: actorUserId || null,
      createdBy: actorUserId || null,
      updatedBy: actorUserId || null,
    },
    { transaction }
  );

  await RuleScope.create(
    {
      groupId,
      companyId,
      ruleVersionId: version.id,
      scopeType: 'GLOBAL',
      scopeRefId: null,
      precedence: 7,
      createdBy: actorUserId || null,
      updatedBy: actorUserId || null,
    },
    { transaction }
  );

  await RulePublication.create(
    {
      groupId,
      companyId,
      ruleVersionId: version.id,
      publishedByUserId: actorUserId || null,
      publishedAt: now,
      createdBy: actorUserId || null,
      updatedBy: actorUserId || null,
    },
    { transaction }
  );

  return version;
}

/**
 * resolveEligibilityConfig — resolve a configuração vigente via Motor de Regras genérico, com
 * semeadura automática do padrão no primeiro uso do tenant (mesmo padrão de
 * getActiveHighValueThreshold/REG-EST-002).
 */
async function resolveEligibilityConfig(groupId, companyId, transaction, actorUserId) {
  let evaluation = await evaluateRule(RULE_CODE, { eligibilityCheckActive: true }, { groupId, companyId }, { transaction });
  if (evaluation.decision !== 'APPLY') {
    await publishProviderEligibilityVersion(groupId, companyId, DEFAULT_ACTION, actorUserId || null, transaction);
    evaluation = await evaluateRule(RULE_CODE, { eligibilityCheckActive: true }, { groupId, companyId }, { transaction });
  }
  if (evaluation.decision !== 'APPLY') {
    throw AppError.unprocessable(
      'Não foi possível resolver a configuração de elegibilidade de provider para esta empresa.',
      'COR_ELIGIBILITY_NOT_CONFIGURED'
    );
  }
  return { ruleVersionId: evaluation.ruleVersionId, action: evaluation.action };
}

/**
 * assertEligible — FAIL CLOSED: bloqueia com motivo claro em português sempre que o
 * provider/finalidade/valor do caso não baterem com a configuração vigente da regra. Chamado
 * ANTES de simular (Fase 3) e será chamado ANTES de submeter (Fase 5, ainda não implementada).
 * `financingCase` precisa ter `providerCode` e `purpose`; `amount` é o valor sendo
 * simulado/submetido (não necessariamente igual em toda chamada — cada simulação pode ter um
 * valor diferente).
 */
async function assertEligible(financingCase, { amount } = {}, groupId, companyId, actorUserId, transaction) {
  const { action, ruleVersionId } = await resolveEligibilityConfig(groupId, companyId, transaction, actorUserId);

  const providerCode = financingCase.providerCode;
  const purpose = financingCase.purpose || 'RESIDENCIAL';

  const allowedProviders = Array.isArray(action.allowedProviders) ? action.allowedProviders : [];
  if (!allowedProviders.includes(providerCode)) {
    await logIneligible(groupId, companyId, actorUserId, financingCase.id, ruleVersionId, `Provider "${providerCode}" não está habilitado para elegibilidade de financiamento.`, transaction);
    throw AppError.unprocessable(
      `O provider "${providerCode}" não está elegível para financiamento no momento. Fale com o administrador do sistema para habilitar este provider.`,
      'COR_ELIGIBILITY_PROVIDER_NOT_ALLOWED'
    );
  }

  const allowedPurposes = Array.isArray(action.allowedPurposes) ? action.allowedPurposes : [];
  if (!allowedPurposes.includes(purpose)) {
    await logIneligible(groupId, companyId, actorUserId, financingCase.id, ruleVersionId, `Finalidade "${purpose}" não está elegível para financiamento.`, transaction);
    throw AppError.unprocessable(
      `A finalidade "${purpose}" deste caso não está elegível para financiamento no momento.`,
      'COR_ELIGIBILITY_PURPOSE_NOT_ALLOWED'
    );
  }

  // GAP REAL FECHADO (18/10/2026 — CORRESPONDENT-ELIG-09 falhava porque esta checagem nunca
  // tinha sido implementada, só o teste existia): elegibilidade por REGIÃO. Quando a
  // RuleVersion define allowedStatesByProvider para o provider E o caso tem imóvel vinculado,
  // a UF do imóvel precisa estar na lista — fora dela, bloqueia com motivo claro. Sem
  // configuração de região pro provider (undefined/null) nada muda: a regra é opt-in, como os
  // demais limiares desta mesma regra.
  const allowedStatesByProvider = action.allowedStatesByProvider || {};
  const allowedStates = allowedStatesByProvider[providerCode];
  if (Array.isArray(allowedStates) && financingCase.propertyId) {
    const property = await Property.findOne({ where: { id: financingCase.propertyId, groupId, companyId }, transaction });
    const propertyState = property?.state ? String(property.state).toUpperCase() : null;
    if (propertyState && !allowedStates.map((uf) => String(uf).toUpperCase()).includes(propertyState)) {
      await logIneligible(
        groupId,
        companyId,
        actorUserId,
        financingCase.id,
        ruleVersionId,
        `Imóvel na UF "${propertyState}" fora das regiões habilitadas (${allowedStates.join(', ')}) para o provider "${providerCode}".`,
        transaction
      );
      throw AppError.unprocessable(
        `O imóvel deste caso fica em ${propertyState}, fora das regiões habilitadas para o provider "${providerCode}" (${allowedStates.join(', ')}).`,
        'COR_ELIGIBILITY_REGION_NOT_ALLOWED'
      );
    }
  }

  const maxAmountByProvider = action.maxAmountByProvider || {};
  const maxAmount = maxAmountByProvider[providerCode];
  if (maxAmount !== null && maxAmount !== undefined && Number(amount) > Number(maxAmount)) {
    await logIneligible(
      groupId,
      companyId,
      actorUserId,
      financingCase.id,
      ruleVersionId,
      `Valor R$ ${Number(amount).toFixed(2)} acima do teto de R$ ${Number(maxAmount).toFixed(2)} para o provider "${providerCode}".`,
      transaction
    );
    throw AppError.unprocessable(
      `O valor solicitado (R$ ${Number(amount).toFixed(2)}) está acima do limite aceito pelo provider "${providerCode}" (até R$ ${Number(maxAmount).toFixed(2)}). Tente um provider diferente ou ajuste o valor.`,
      'COR_ELIGIBILITY_AMOUNT_EXCEEDS_LIMIT'
    );
  }

  return { eligible: true, ruleVersionId };
}

async function logIneligible(groupId, companyId, actorUserId, financingCaseId, ruleVersionId, reason, transaction) {
  if (!groupId || !companyId) return;
  await registrarAuditoria(
    {
      groupId,
      companyId,
      actorUserId,
      action: 'correspondent.eligibility.denied',
      entityType: 'FinancingCase',
      entityId: financingCaseId,
      reason: `Caso bloqueado por inelegibilidade (${RULE_CODE}, versão ${ruleVersionId || 'n/d'}): ${reason}`,
    },
    transaction
  ).catch(() => {});
}

module.exports = {
  assertEligible,
  resolveEligibilityConfig,
  publishProviderEligibilityVersion,
  RULE_CODE,
  DEFAULT_ACTION,
};
