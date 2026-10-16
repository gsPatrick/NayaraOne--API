'use strict';

const crypto = require('crypto');
const { Rule, RuleVersion, RuleScope, RulePublication, sequelize } = require('../../models');
const AppError = require('../../utils/AppError');
const { evaluateRule } = require('../../engines/rules/rulesEngine');

/**
 * COR_COMMISSION_SPLIT — Marco 8 Fase 8 (Caderno: "Split corretor/gerente vem do Motor de
 * Regras.", "Comissão guarda fato gerador, provider, base e rule_version_id."). MESMO padrão
 * arquitetural já usado por COR_PROVIDER_ELIGIBILITY (Fase 4) e REG-EST-002: a regra guarda
 * CONFIGURAÇÃO (percentual de comissão por provider) no `actionJson`; o cálculo concreto é
 * aplicado em código usando essa config — nunca hard-coded, nunca embutido no AST da regra.
 */
const RULE_CODE = 'COR_COMMISSION_SPLIT';
const RULE_NAME = 'Percentual de comissão (NC) por provider de financiamento';
const RULE_DOMAIN = 'correspondent';
const CONDITION_AST = { fact: 'commissionSplitActive', op: '==', value: true };

// Semente inicial — nenhum documento fonte define percentuais exatos ("split vem do Motor de
// Regras" sem definir o número); usado só como valor padrão no primeiro uso do tenant. Depois de
// publicada, quem decide é a RuleVersion (editável via publishCommissionSplitVersion).
const DEFAULT_ACTION = {
  percentageByProvider: { sandbox: 1.5, manual: 1 },
  defaultPercentage: 1,
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
        description: 'Percentual de comissão de correspondente bancário (NC) por provider. Split nunca hard-coded — tudo vem desta regra.',
        domain: RULE_DOMAIN,
        createdBy: actorUserId || null,
        updatedBy: actorUserId || null,
      },
      { transaction }
    );
  }
  return rule;
}

async function publishCommissionSplitVersion(groupId, companyId, action, actorUserId, transaction) {
  const lockKey = `commission_split_rule:${groupId}:${companyId}:${RULE_CODE}`;
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
 * resolveCommissionSplit — resolve o percentual vigente para `providerCode` via Motor de Regras
 * genérico, com semeadura automática no primeiro uso do tenant (mesmo padrão de
 * resolveEligibilityConfig/REG-EST-002).
 */
async function resolveCommissionSplit(providerCode, groupId, companyId, actorUserId, transaction) {
  let evaluation = await evaluateRule(RULE_CODE, { commissionSplitActive: true }, { groupId, companyId }, { transaction });
  if (evaluation.decision !== 'APPLY') {
    await publishCommissionSplitVersion(groupId, companyId, DEFAULT_ACTION, actorUserId || null, transaction);
    evaluation = await evaluateRule(RULE_CODE, { commissionSplitActive: true }, { groupId, companyId }, { transaction });
  }
  if (evaluation.decision !== 'APPLY') {
    throw AppError.unprocessable(
      'Não foi possível resolver o percentual de comissão de correspondente para esta empresa.',
      'COR_COMMISSION_SPLIT_NOT_CONFIGURED'
    );
  }
  const action = evaluation.action || {};
  const percentageByProvider = action.percentageByProvider || {};
  const percentage = percentageByProvider[providerCode] ?? action.defaultPercentage;
  if (percentage === undefined || percentage === null || !Number.isFinite(Number(percentage)) || Number(percentage) <= 0) {
    throw AppError.unprocessable(
      `Nenhum percentual de comissão configurado para o provider "${providerCode}".`,
      'COR_COMMISSION_SPLIT_PERCENTAGE_NOT_CONFIGURED'
    );
  }
  // Achado real (auditoria pós-DoD, Frente Motor de Regras): não havia teto superior — uma
  // config publicada com percentual > 100 (erro de digitação do admin, ex: 150 em vez de 1.5)
  // geraria uma comissão MAIOR que a própria base de cálculo, sem nenhum alerta. Comissão de
  // correspondente nunca pode exceder 100% da base.
  if (Number(percentage) > 100) {
    throw AppError.unprocessable(
      `Percentual de comissão configurado para o provider "${providerCode}" (${percentage}%) está acima do limite de 100%. Corrija a regra de comissão antes de continuar.`,
      'COR_COMMISSION_SPLIT_PERCENTAGE_TOO_HIGH'
    );
  }
  return { percentage: Number(percentage), ruleVersionId: evaluation.ruleVersionId };
}

module.exports = {
  resolveCommissionSplit,
  publishCommissionSplitVersion,
  RULE_CODE,
  DEFAULT_ACTION,
};
