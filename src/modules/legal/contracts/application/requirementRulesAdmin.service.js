'use strict';

const { Rule, RuleVersion } = require('../../../../models');
const AppError = require('../../../../utils/AppError');
const { RULE_CODE, STAGES, publishRequirementRules } = require('./requirementRules.service');
const { DEFAULT_ACTION } = require('./requirementRules.defaults');
const { KNOWN_FACTS } = require('./requirementRules.facts');
const { BOOK_CONTRACT_TYPES } = require('../domain/contractTypes');

/**
 * Administração da regra REG-JUR-001 (checklist documental, Caderno M5 §7) pela empresa — verificação M5 linha 65: a política
 * deixa de ser trocável só por código. Ler a vigente e o histórico (legal:read); publicar nova versão (legal:approve, motivo
 * obrigatório, auditoria `legal.requirement_rules.publish` com versão anterior e nova). A versão vigente nunca é editada:
 * publicar fecha a anterior e cria a próxima (Motor de Regras).
 */
const toVersion = (v) => ({
  id: v.id, versionNumber: v.versionNumber, status: v.status, contentHash: v.contentHash,
  effectiveFrom: v.effectiveFrom, effectiveUntil: v.effectiveUntil, publishedByUserId: v.publishedByUserId,
});

/**
 * Vigente + o catálogo do que a política pode usar. Só leitura: sem versão publicada ainda (empresa que nunca gerou checklist),
 * devolve o padrão do Caderno que será semeado na primeira geração (`version: null`, `seedDefault: true`).
 */
async function getRequirementRules(tenant, transaction) {
  const rule = await Rule.findOne({ where: { code: RULE_CODE, groupId: tenant.groupId, companyId: tenant.companyId }, transaction });
  const vigente = rule ? await RuleVersion.findOne({ where: { ruleId: rule.id, status: 'PUBLISHED', effectiveUntil: null }, order: [['versionNumber', 'DESC']], transaction }) : null;
  return {
    ruleCode: RULE_CODE,
    version: vigente ? toVersion(vigente) : null,
    seedDefault: !vigente,
    action: vigente ? vigente.actionJson : DEFAULT_ACTION,
    catalog: { facts: KNOWN_FACTS, stages: STAGES, contractTypes: BOOK_CONTRACT_TYPES },
  };
}

async function listRequirementRuleVersions(tenant, transaction) {
  const rule = await Rule.findOne({ where: { code: RULE_CODE, groupId: tenant.groupId, companyId: tenant.companyId }, transaction });
  if (!rule) return [];
  const versions = await RuleVersion.findAll({ where: { ruleId: rule.id }, order: [['versionNumber', 'DESC']], transaction });
  return versions.map((v) => ({ ...toVersion(v), action: v.actionJson }));
}

/** POST /legal/requirement-rules { action: { templates, typeToTemplate }, reason }. */
async function publishRequirementRulesVersion(tenant, body, actorUserId, transaction) {
  const { action, reason } = body || {};
  if (typeof reason !== 'string' || reason.trim().length < 5 || reason.length > 500) {
    throw AppError.badRequest('Informe o motivo da nova versão da política do checklist ("reason", de 5 a 500 caracteres).', 'LEGAL_REQUIREMENT_RULE_REASON_REQUIRED');
  }
  if (!actorUserId) throw AppError.forbidden('Publicar a política exige um usuário identificado.', 'LEGAL_REQUIREMENT_RULE_ACTOR_REQUIRED');
  const version = await publishRequirementRules(tenant, action, actorUserId, transaction, { reason: reason.trim() });
  return { ruleCode: RULE_CODE, version: toVersion(version), action: version.actionJson };
}

module.exports = { getRequirementRules, listRequirementRuleVersions, publishRequirementRulesVersion };
