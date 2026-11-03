'use strict';

const crypto = require('crypto');
const { Rule, RuleVersion, RuleScope, RulePublication, sequelize } = require('../../models');
const AppError = require('../../utils/AppError');
const { registrarAuditoria } = require('../../engines/audit/auditLog.service');
const { evaluateRule } = require('../../engines/rules/rulesEngine');

// GAP REAL CORRIGIDO (auditoria contratual, 2026-10-08 — Anexo "Arquitetura Técnica Blindada",
// princípio constitucional "quem cria não aprova; quem aprova não altera; quem executa valida o
// hash aprovado"): o ciclo de Compras não tinha NENHUMA alçada por VALOR — qualquer ator com
// `procurement:approve` podia adjudicar uma oferta de R$5 ou de R$5.000.000 sozinho, com a mesma
// exigência fixa (um único aprovador, diferente de quem criou a PurchaseRequest — ver Tarefa 1 em
// procurement.service.js). Mesmo padrão já usado em REG-EST-002
// (inventory/adjustmentRiskRules.service.js) — um limiar de VALOR configurável via Motor de
// Regras genérico, acima do qual passa a ser exigido um SEGUNDO aprovador (diferente de quem
// decidiu a PurchaseRequest), em vez de hardcodar o número no código.
const RULE_CODE = 'REG-COM-001';
const RULE_NAME = 'Limite de valor para segunda aprovação de pedido de compra';
const RULE_DOMAIN = 'procurement';
const CONDITION_AST = { fact: 'approvalThresholdRuleActive', op: '==', value: true };

// Valor padrão — nenhum documento fonte define o número exato pra "segunda aprovação de pedido
// de compra"; decisão de engenharia alinhada à ordem de grandeza de uma PO/oferta de fornecedor
// (tipicamente de valor unitário/total bem maior que um ajuste de estoque — por isso o limiar
// aqui é maior que o de REG-EST-002, R$1.000) e a FIN-005 (newAccountThreshold R$10.000, fraude
// de pagamento) — usado apenas como SEMENTE inicial; depois de publicada, quem decide é a
// RuleVersion.
const DEFAULT_SECOND_APPROVAL_THRESHOLD = 50000;

function hashCondition(conditionAstJson) {
  return crypto.createHash('sha256').update(JSON.stringify(conditionAstJson)).digest('hex');
}

function validateThreshold(secondApprovalThreshold) {
  const numeric = Number(secondApprovalThreshold);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    throw AppError.badRequest('"secondApprovalThreshold" deve ser um número maior que zero.', 'APPROVAL_THRESHOLD_RULE_VALIDATION');
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
        description: 'Valor (R$) de oferta adjudicada/PO acima do qual é exigido um segundo aprovador, diferente de quem decidiu a requisição de compra original.',
        domain: RULE_DOMAIN,
        createdBy: actorUserId || null,
        updatedBy: actorUserId || null,
      },
      { transaction }
    );
  }
  return rule;
}

async function publishApprovalThresholdRuleVersion(groupId, companyId, secondApprovalThreshold, description, actorUserId, transaction) {
  const lockKey = `approval_threshold_rule:${groupId}:${companyId}:${RULE_CODE}`;
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

  const actionJson = { secondApprovalThreshold, description: description || null };
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

async function createApprovalThresholdRule(payload, actorUserId, transaction) {
  const { groupId, companyId, secondApprovalThreshold, description } = payload;
  if (!groupId || !companyId) {
    throw AppError.badRequest('Os campos "groupId" e "companyId" são obrigatórios.', 'APPROVAL_THRESHOLD_RULE_VALIDATION');
  }
  const normalized = validateThreshold(secondApprovalThreshold);

  const version = await publishApprovalThresholdRuleVersion(groupId, companyId, normalized, description, actorUserId, transaction);

  await registrarAuditoria(
    {
      groupId,
      companyId,
      actorUserId,
      action: 'procurement.approval_threshold_rule.create',
      entityType: 'RuleVersion',
      entityId: version.id,
      afterJson: { id: version.id, secondApprovalThreshold: normalized, description: description || null, ruleCode: RULE_CODE },
      reason: `Nova versão do limite de valor para segunda aprovação de pedido de compra (${RULE_CODE}) criada no Motor de Regras genérico.`,
    },
    transaction
  );

  return { id: version.id, groupId, companyId, secondApprovalThreshold: normalized, description: description || null, isActive: true };
}

/**
 * getActiveSecondApprovalThreshold — resolve o limiar vigente via Motor de Regras genérico, com
 * semeadura automática do valor padrão no primeiro uso do tenant (mesmo padrão de
 * getActiveHighValueThreshold, REG-EST-002, já usado neste projeto).
 */
async function getActiveSecondApprovalThreshold(groupId, companyId, transaction, actorUserId) {
  let evaluation = await evaluateRule(RULE_CODE, { approvalThresholdRuleActive: true }, { groupId, companyId }, { transaction });
  if (evaluation.decision !== 'APPLY') {
    await publishApprovalThresholdRuleVersion(groupId, companyId, DEFAULT_SECOND_APPROVAL_THRESHOLD, 'Valor padrão (seed automático).', actorUserId || null, transaction);
    evaluation = await evaluateRule(RULE_CODE, { approvalThresholdRuleActive: true }, { groupId, companyId }, { transaction });
  }
  if (evaluation.decision !== 'APPLY') {
    throw AppError.unprocessable(
      'Não foi possível resolver o limite de valor para segunda aprovação de pedido de compra configurado para esta empresa.',
      'APPROVAL_THRESHOLD_RULE_NOT_CONFIGURED'
    );
  }
  return {
    ruleVersionId: evaluation.ruleVersionId,
    secondApprovalThreshold: Number(evaluation.action.secondApprovalThreshold),
  };
}

// BUG REAL CORRIGIDO (reauditoria RLS/multi-tenant, mesmo padrão já corrigido em
// adjustmentRiskRules.service.js/getAdjustmentRiskRule): findByPk(id) sem filtro de
// groupId/companyId deixaria qualquer tenant ler o limiar REG-COM-001 de outra empresa só
// adivinhando o UUID da RuleVersion — projeto não usa RLS real do Postgres (SET LOCAL
// app.group_id/app.company_id em tenant.middleware.js não tem CREATE POLICY correspondente),
// então o isolamento é 100% a cargo do filtro manual no where.
async function getApprovalThresholdRule(id, groupId, companyId, transaction) {
  const version = await RuleVersion.findOne({ where: { id, groupId, companyId }, transaction });
  if (!version) throw AppError.notFound('Regra de limite de segunda aprovação não encontrada.', 'APPROVAL_THRESHOLD_RULE_NOT_FOUND');
  return {
    id: version.id,
    secondApprovalThreshold: version.actionJson?.secondApprovalThreshold != null ? Number(version.actionJson.secondApprovalThreshold) : null,
    description: version.actionJson?.description || null,
    isActive: version.status === 'PUBLISHED' && !version.effectiveUntil,
  };
}

module.exports = {
  createApprovalThresholdRule,
  getActiveSecondApprovalThreshold,
  getApprovalThresholdRule,
  RULE_CODE,
  DEFAULT_SECOND_APPROVAL_THRESHOLD,
};
