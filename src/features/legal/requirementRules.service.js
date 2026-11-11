'use strict';

const crypto = require('crypto');
const { Rule, RuleVersion, RuleScope, RulePublication, ContractParty, Person, Property, sequelize } = require('../../models');
const AppError = require('../../utils/AppError');
const { registrarAuditoria } = require('../../engines/audit/auditLog.service');
const { evaluateRule } = require('../../engines/rules/rulesEngine');
const { evaluateNode, RuleEvaluationError } = require('../../engines/rules/ruleEvaluator');
const { DEFAULT_ACTION } = require('./requirementRules.defaults');

/**
 * Checklist documental pelo Motor de Regras (Caderno M5 §7 "Requirements são gerados por tipo de contrato +
 * regras + características das partes/imóvel"; Guia §20 "Requirements engine integrado ao Motor de Regras").
 *
 * Regra REG-JUR-001 (core.rules), uma versão vigente por empresa (escopo GLOBAL). A ação da versão traz os
 * modelos de checklist por tipo e, em cada item, a condição declarativa (`when`, DSL do ruleEvaluator) sobre os
 * fatos do contrato, das partes (PF/PJ, representada por procurador, papéis) e do imóvel. Sem regra publicada,
 * a empresa recebe a semente com o padrão do Caderno (requirementRules.defaults.js) — mesmo padrão de semente
 * de REG-EST-001/REG-OBR-001. Trocar a política = publicar nova versão (a anterior é fechada, nunca editada).
 */
const RULE_CODE = 'REG-JUR-001';
const CONDITION_AST = { fact: 'checklistRuleActive', op: '==', value: true };
const PRECEDENCE_GLOBAL = 7;
const STAGES = ['LEGAL_REVIEW', 'LEGAL_APPROVAL', 'SIGNING', 'ACTIVATION', 'KEY_DELIVERY'];

function validateAction(action) {
  if (!action || typeof action !== 'object' || !action.templates || typeof action.templates !== 'object' || !action.typeToTemplate) {
    throw AppError.badRequest('A política do checklist precisa de "templates" e "typeToTemplate".', 'LEGAL_REQUIREMENT_RULE_VALIDATION');
  }
  for (const [key, items] of Object.entries(action.templates)) {
    if (!Array.isArray(items)) throw AppError.badRequest(`Modelo de checklist "${key}" inválido.`, 'LEGAL_REQUIREMENT_RULE_VALIDATION');
    for (const item of items) {
      if (!item.requirementCode || !item.requirementType || !item.description) {
        throw AppError.badRequest(`Item do modelo "${key}" precisa de requirementCode, requirementType e description.`, 'LEGAL_REQUIREMENT_RULE_VALIDATION');
      }
      if (item.stage && !STAGES.includes(item.stage)) throw AppError.badRequest(`Etapa inválida "${item.stage}" em ${item.requirementCode}.`, 'LEGAL_REQUIREMENT_RULE_VALIDATION');
      if (item.when) {
        try { evaluateNode(item.when, {}); } catch (err) { if (err instanceof RuleEvaluationError) throw AppError.badRequest(`Condição inválida em ${item.requirementCode}: ${err.message}`, 'LEGAL_REQUIREMENT_RULE_VALIDATION'); }
      }
    }
  }
  return action;
}

/** Publica nova versão da política (fecha a vigente 1 ms antes; histórico preservado no Motor de Regras). */
async function publishRequirementRules(tenant, action, actorUserId, transaction) {
  const { groupId, companyId } = tenant;
  validateAction(action);
  await sequelize.query('SELECT pg_advisory_xact_lock(hashtextextended(:k, 0))', { replacements: { k: `requirement_rules:${companyId}` }, transaction });
  let rule = await Rule.findOne({ where: { code: RULE_CODE, groupId, companyId }, transaction });
  if (!rule) {
    rule = await Rule.create({ groupId, companyId, code: RULE_CODE, name: 'Checklist documental do contrato', description: 'Exigências por tipo de contrato e características das partes/imóvel (Caderno M5 §7).', domain: 'legal', createdBy: actorUserId || null, updatedBy: actorUserId || null }, { transaction });
  }
  const now = new Date();
  const vigente = await RuleVersion.findOne({ where: { ruleId: rule.id, status: 'PUBLISHED', effectiveUntil: null }, order: [['versionNumber', 'DESC']], transaction });
  await RuleVersion.update({ effectiveUntil: new Date(now.getTime() - 1), updatedBy: actorUserId || null }, { where: { ruleId: rule.id, status: 'PUBLISHED', effectiveUntil: null }, transaction });
  const last = await RuleVersion.findOne({ where: { ruleId: rule.id }, order: [['versionNumber', 'DESC']], transaction });
  const version = await RuleVersion.create({
    groupId, companyId, ruleId: rule.id, versionNumber: last ? last.versionNumber + 1 : 1, conditionAstJson: CONDITION_AST,
    contentHash: crypto.createHash('sha256').update(JSON.stringify(action)).digest('hex'), actionJson: action,
    effectiveFrom: now, effectiveUntil: null, status: 'PUBLISHED', publishedByUserId: actorUserId || null, createdBy: actorUserId || null, updatedBy: actorUserId || null,
  }, { transaction });
  await RuleScope.create({ groupId, companyId, ruleVersionId: version.id, scopeType: 'GLOBAL', scopeRefId: null, precedence: PRECEDENCE_GLOBAL, createdBy: actorUserId || null, updatedBy: actorUserId || null }, { transaction });
  await RulePublication.create({ groupId, companyId, ruleVersionId: version.id, publishedByUserId: actorUserId || null, publishedAt: now, createdBy: actorUserId || null, updatedBy: actorUserId || null }, { transaction });
  await registrarAuditoria({ groupId, companyId, actorUserId, action: 'legal.requirement_rules.publish', entityType: 'RuleVersion', entityId: version.id, beforeJson: { ruleCode: RULE_CODE, versaoVigenteAnterior: vigente ? vigente.versionNumber : null, situacao: vigente ? 'versão anterior fechada' : 'sem política publicada' }, afterJson: { ruleCode: RULE_CODE, versionNumber: version.versionNumber }, reason: `Política do checklist documental (${RULE_CODE}) publicada na versão ${version.versionNumber}.` }, transaction);
  return version;
}

/** Política vigente da empresa: avalia REG-JUR-001; sem versão publicada, semeia o padrão do Caderno e reavalia. */
async function resolveRequirementPolicy(tenant, actorUserId, transaction) {
  const ctx = { checklistRuleActive: true, groupId: tenant.groupId, companyId: tenant.companyId };
  let outcome = await evaluateRule(RULE_CODE, ctx, tenant, { transaction });
  if (outcome.decision !== 'APPLY' && ['RULE_NOT_FOUND', 'RULE_NO_ACTIVE_VERSION'].includes(outcome.reason)) {
    await publishRequirementRules(tenant, DEFAULT_ACTION, actorUserId, transaction);
    outcome = await evaluateRule(RULE_CODE, ctx, tenant, { transaction });
  }
  if (outcome.decision !== 'APPLY') {
    throw AppError.conflict(`Não foi possível resolver a política do checklist documental (${outcome.reason}).`, 'LEGAL_REQUIREMENT_RULE_UNAVAILABLE');
  }
  return { action: outcome.action, ruleVersionId: outcome.ruleVersionId };
}

/** Fatos do contrato, das partes (do cadastro) e do imóvel que as condições dos itens consultam. */
async function buildFacts(contract, templateKey, transaction) {
  const parties = await ContractParty.findAll({ where: { contractId: contract.id }, transaction });
  const persons = parties.length ? await Person.findAll({ where: { id: parties.map((p) => p.personId) }, attributes: ['id', 'personType'], transaction }) : [];
  const types = new Set(persons.map((p) => p.personType));
  const property = contract.propertyId ? await Property.findByPk(contract.propertyId, { attributes: ['id', 'propertyType', 'registryNumber'], transaction }) : null;
  return {
    contractType: contract.contractType,
    templateKey: templateKey || null,
    parties: { count: parties.length, anyPF: types.has('PF'), anyPJ: types.has('PJ'), anyRepresented: parties.some((p) => !!p.representedByPersonId), roles: [...new Set(parties.map((p) => p.partyRole))] },
    property: { linked: !!property, propertyType: property ? property.propertyType : null, hasRegistry: !!(property && property.registryNumber) },
  };
}

/** Itens que se aplicam ao contrato: modelo do tipo (ou `templateKey`) filtrado pelas condições sobre os fatos. */
async function resolveRequirementItems(contract, { templateKey } = {}, actorUserId, transaction) {
  const { action, ruleVersionId } = await resolveRequirementPolicy({ groupId: contract.groupId, companyId: contract.companyId }, actorUserId, transaction);
  const key = templateKey || action.typeToTemplate[contract.contractType];
  const template = key ? action.templates[key] : null;
  if (!template) return { key, items: null, ruleVersionId, facts: null };
  const facts = await buildFacts(contract, templateKey, transaction);
  const items = template.filter((item) => !item.when || evaluateNode(item.when, facts)).map((item) => ({ ...item, stage: item.stage || 'LEGAL_REVIEW' }));
  return { key, items, ruleVersionId, facts };
}

module.exports = { RULE_CODE, STAGES, publishRequirementRules, resolveRequirementPolicy, resolveRequirementItems, buildFacts };
