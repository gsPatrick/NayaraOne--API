'use strict';

const crypto = require('crypto');
const { Rule, RuleVersion, RuleScope, RulePublication, sequelize } = require('../../models');
const AppError = require('../../utils/AppError');
const { registrarAuditoria } = require('../../engines/audit/auditLog.service');
const { evaluateRule } = require('../../engines/rules/rulesEngine');

// GAP REAL CORRIGIDO (reauditoria externa Nayara, 3ª rodada, 2026-10-08): EST-008 ("Ajuste de
// estoque exige motivo, evidência e aprovação conforme valor/risco") já tinha motivo obrigatório
// e aprovação (actor.canApprove) para ADJUSTMENT/LOSS/DISPOSAL — mas "conforme valor/risco" não
// tinha NENHUMA tradução em código: o mesmo ajuste de R$50 ou de R$50.000 passava pela mesma
// exigência fixa. Mesmo padrão já usado pelo Financeiro (FIN-005, financeAntifraud.service.js)
// e por REG-OBR-001/REG-OBR-002/REG-EST-001 — um limiar de VALOR configurável via Motor de
// Regras genérico, acima do qual a evidência deixa de ser opcional e passa a ser obrigatória
// (a aprovação, via actor.canApprove, já é obrigatória para os três tipos de qualquer forma —
// "conforme risco" nesse eixo já está coberto; o eixo que faltava era "conforme valor").
const RULE_CODE = 'REG-EST-002';
const RULE_NAME = 'Limite de valor para evidência obrigatória em ajuste/perda/descarte de estoque';
const RULE_DOMAIN = 'inventory';
const CONDITION_AST = { fact: 'adjustmentRiskRuleActive', op: '==', value: true };

// Valor padrão — nenhum documento fonte define o número exato ("conforme valor/risco" não traz
// um limiar numérico); decisão de engenharia alinhada à ordem de grandeza já usada em
// FIN-005 (newAccountThreshold default R$10.000, para fraude de pagamento) mas numa escala
// menor, já que aqui o "risco" é um ajuste físico de estoque, tipicamente de menor valor
// unitário — usado apenas como SEMENTE inicial; depois de publicada, quem decide é a RuleVersion.
const DEFAULT_HIGH_VALUE_THRESHOLD = 1000;

function hashCondition(conditionAstJson) {
  return crypto.createHash('sha256').update(JSON.stringify(conditionAstJson)).digest('hex');
}

function validateThreshold(highValueThreshold) {
  const numeric = Number(highValueThreshold);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    throw AppError.badRequest('"highValueThreshold" deve ser um número maior que zero.', 'ADJUSTMENT_RISK_RULE_VALIDATION');
  }
  return numeric;
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
        description: 'Valor (R$) de ajuste/perda/descarte de estoque acima do qual evidência fotográfica passa a ser obrigatória, não apenas recomendada.',
        domain: RULE_DOMAIN,
        createdBy: actorUserId || null,
        updatedBy: actorUserId || null,
      },
      { transaction }
    );
  }
  return rule;
}

async function publishAdjustmentRiskRuleVersion(groupId, companyId, highValueThreshold, description, actorUserId, transaction) {
  const lockKey = `adjustment_risk_rule:${groupId}:${companyId}:${RULE_CODE}`;
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

  const lastVersion = await RuleVersion.findOne({
    where: { ruleId: rule.id },
    order: [['versionNumber', 'DESC']],
    transaction,
  });
  const nextVersionNumber = lastVersion ? lastVersion.versionNumber + 1 : 1;

  const actionJson = { highValueThreshold, description: description || null };
  const version = await RuleVersion.create(
    {
      groupId,
      companyId,
      ruleId: rule.id,
      versionNumber: nextVersionNumber,
      conditionAstJson: CONDITION_AST,
      contentHash: hashCondition(CONDITION_AST),
      actionJson,
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

async function createAdjustmentRiskRule(payload, actorUserId, transaction) {
  const { groupId, companyId, highValueThreshold, description } = payload;
  if (!groupId || !companyId) {
    throw AppError.badRequest('Os campos "groupId" e "companyId" são obrigatórios.', 'ADJUSTMENT_RISK_RULE_VALIDATION');
  }
  const normalized = validateThreshold(highValueThreshold);

  const version = await publishAdjustmentRiskRuleVersion(groupId, companyId, normalized, description, actorUserId, transaction);

  await registrarAuditoria(
    {
      groupId,
      companyId,
      actorUserId,
      action: 'inventory.adjustment_risk_rule.create',
      entityType: 'RuleVersion',
      entityId: version.id,
      afterJson: { id: version.id, highValueThreshold: normalized, description: description || null, ruleCode: RULE_CODE },
      reason: `Nova versão do limite de valor/risco de ajuste de estoque (${RULE_CODE}) criada no Motor de Regras genérico.`,
    },
    transaction
  );

  return { id: version.id, groupId, companyId, highValueThreshold: normalized, description: description || null, isActive: true };
}

/**
 * getActiveHighValueThreshold — resolve o limiar vigente via Motor de Regras genérico, com
 * semeadura automática do valor padrão no primeiro uso do tenant (mesmo padrão de
 * getActiveSlaDaysMap/getActiveMinStockPolicy já usados neste projeto).
 */
async function getActiveHighValueThreshold(groupId, companyId, transaction, actorUserId) {
  let evaluation = await evaluateRule(RULE_CODE, { adjustmentRiskRuleActive: true }, { groupId, companyId }, { transaction });
  if (evaluation.decision !== 'APPLY') {
    await publishAdjustmentRiskRuleVersion(groupId, companyId, DEFAULT_HIGH_VALUE_THRESHOLD, 'Valor padrão (seed automático).', actorUserId || null, transaction);
    evaluation = await evaluateRule(RULE_CODE, { adjustmentRiskRuleActive: true }, { groupId, companyId }, { transaction });
  }
  if (evaluation.decision !== 'APPLY') {
    throw AppError.unprocessable(
      'Não foi possível resolver o limite de valor/risco de ajuste de estoque configurado para esta empresa.',
      'ADJUSTMENT_RISK_RULE_NOT_CONFIGURED'
    );
  }
  return {
    ruleVersionId: evaluation.ruleVersionId,
    highValueThreshold: Number(evaluation.action.highValueThreshold),
  };
}

// BUG REAL CORRIGIDO (reauditoria RLS/multi-tenant, rodada 5, 2026-10-08): findByPk(id) sem
// filtro de groupId/companyId deixava qualquer tenant ler o limiar REG-EST-002 de outra
// empresa só adivinhando o UUID da RuleVersion — projeto não usa RLS real do Postgres
// (SET LOCAL app.group_id/company_id em tenant.middleware.js não tem nenhuma CREATE POLICY
// correspondente), então o isolamento é 100% a cargo do filtro manual no where.
async function getAdjustmentRiskRule(id, groupId, companyId, transaction) {
  const version = await RuleVersion.findOne({ where: { id, groupId, companyId }, transaction });
  if (!version) throw AppError.notFound('Regra de limite de valor/risco não encontrada.', 'ADJUSTMENT_RISK_RULE_NOT_FOUND');
  return {
    id: version.id,
    highValueThreshold: version.actionJson?.highValueThreshold != null ? Number(version.actionJson.highValueThreshold) : null,
    description: version.actionJson?.description || null,
    isActive: version.status === 'PUBLISHED' && !version.effectiveUntil,
  };
}

module.exports = {
  createAdjustmentRiskRule,
  getActiveHighValueThreshold,
  getAdjustmentRiskRule,
  RULE_CODE,
  DEFAULT_HIGH_VALUE_THRESHOLD,
};
