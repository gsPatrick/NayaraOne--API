'use strict';

const crypto = require('crypto');
const { Rule, RuleVersion, RuleScope, RulePublication, sequelize } = require('../../../../models');
const AppError = require('../../../../utils/AppError');
const { registrarAuditoria } = require('../../../../engines/audit/auditLog.service');
const { evaluateRule } = require('../../../../engines/rules/rulesEngine');
const { evaluateNode, RuleEvaluationError } = require('../../../../engines/rules/ruleEvaluator');
const { DEFAULT_ACTION, PREVIOUS_SEED_HASHES } = require('./requirementRules.defaults');
const { KNOWN_FACTS, factsOf, buildFacts } = require('./requirementRules.facts');

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

const invalid = (msg) => AppError.badRequest(msg, 'LEGAL_REQUIREMENT_RULE_VALIDATION');
const isText = (v, max) => typeof v === 'string' && v.trim().length > 0 && v.length <= max;

function validateItem(key, item) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) throw invalid(`Item do modelo "${key}" inválido.`);
  if (!isText(item.requirementCode, 64) || !isText(item.requirementType, 64) || !isText(item.description, 500)) {
    throw invalid(`Item do modelo "${key}" precisa de requirementCode, requirementType (até 64 caracteres) e description (até 500).`);
  }
  if (item.stage && !STAGES.includes(item.stage)) throw invalid(`Etapa inválida "${item.stage}" em ${item.requirementCode}.`);
  if (item.when) {
    try { evaluateNode(item.when, {}); } catch (err) { if (err instanceof RuleEvaluationError) throw invalid(`Condição inválida em ${item.requirementCode}: ${err.message}`); throw err; }
    const desconhecidos = factsOf(item.when).filter((f) => !Object.prototype.hasOwnProperty.call(KNOWN_FACTS, f));
    if (desconhecidos.length) throw invalid(`Condição de ${item.requirementCode} usa fato desconhecido: ${desconhecidos.join(', ')}. Fatos aceitos: ${Object.keys(KNOWN_FACTS).join(', ')}.`);
  }
}

/** A política: modelos (listas de itens) e o mapa tipo de contrato -> modelo, com referências fechadas. */
function validateAction(action) {
  if (!action || typeof action !== 'object' || !action.templates || typeof action.templates !== 'object' || Array.isArray(action.templates)
    || !action.typeToTemplate || typeof action.typeToTemplate !== 'object' || Array.isArray(action.typeToTemplate)) {
    throw invalid('A política do checklist precisa de "templates" e "typeToTemplate".');
  }
  for (const [key, items] of Object.entries(action.templates)) {
    if (!Array.isArray(items) || items.length === 0) throw invalid(`Modelo de checklist "${key}" precisa de ao menos um item.`);
    const codes = new Set();
    for (const item of items) {
      validateItem(key, item);
      if (codes.has(item.requirementCode)) throw invalid(`Código repetido "${item.requirementCode}" no modelo "${key}".`);
      codes.add(item.requirementCode);
    }
  }
  for (const [type, key] of Object.entries(action.typeToTemplate)) {
    if (!action.templates[key]) throw invalid(`O tipo "${type}" aponta para o modelo "${key}", que não existe na política.`);
  }
  return action;
}

/** Publica nova versão da política (fecha a vigente 1 ms antes; histórico preservado no Motor de Regras). */
async function publishRequirementRules(tenant, action, actorUserId, transaction, { reason = null } = {}) {
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
  await registrarAuditoria({ groupId, companyId, actorUserId, action: 'legal.requirement_rules.publish', entityType: 'RuleVersion', entityId: version.id, beforeJson: { ruleCode: RULE_CODE, versaoVigenteAnterior: vigente ? vigente.versionNumber : null, situacao: vigente ? 'versão anterior fechada' : 'sem política publicada' }, afterJson: { ruleCode: RULE_CODE, versionNumber: version.versionNumber }, reason: `Política do checklist documental (${RULE_CODE}) publicada na versão ${version.versionNumber}${reason ? `: ${reason}` : '.'}` }, transaction);
  return version;
}

/** Política vigente da empresa: avalia REG-JUR-001; sem versão publicada, semeia o padrão do Caderno e reavalia. */
async function resolveRequirementPolicy(tenant, actorUserId, transaction) {
  const ctx = { checklistRuleActive: true, groupId: tenant.groupId, companyId: tenant.companyId };
  let outcome = await evaluateRule(RULE_CODE, ctx, tenant, { transaction });
  if (outcome.decision !== 'APPLY' && ['RULE_NOT_FOUND', 'RULE_NO_ACTIVE_VERSION'].includes(outcome.reason)) {
    await publishRequirementRules(tenant, DEFAULT_ACTION, actorUserId, transaction, { reason: 'semente do padrão do Caderno §7' });
    outcome = await evaluateRule(RULE_CODE, ctx, tenant, { transaction });
  } else if (outcome.decision === 'APPLY' && (await isUntouchedPreviousSeed(outcome.ruleVersionId, transaction))) {
    // DI-M5CT-3: a vigente é a semente anterior sem nenhuma alteração da empresa — recebe a semente atual (com as
    // características do imóvel) como nova versão auditada; política publicada pela empresa nunca é trocada.
    await publishRequirementRules(tenant, DEFAULT_ACTION, actorUserId, transaction, { reason: 'semente atualizada (características do imóvel, Caderno §7); a versão anterior era a semente sem alteração' });
    outcome = await evaluateRule(RULE_CODE, ctx, tenant, { transaction });
  }
  if (outcome.decision !== 'APPLY') {
    throw AppError.conflict(`Não foi possível resolver a política do checklist documental (${outcome.reason}).`, 'LEGAL_REQUIREMENT_RULE_UNAVAILABLE');
  }
  return { action: outcome.action, ruleVersionId: outcome.ruleVersionId };
}

async function isUntouchedPreviousSeed(ruleVersionId, transaction) {
  if (!ruleVersionId) return false;
  const v = await RuleVersion.findByPk(ruleVersionId, { attributes: ['id', 'contentHash'], transaction });
  return Boolean(v && PREVIOUS_SEED_HASHES.includes(v.contentHash));
}

/**
 * Itens que se aplicam ao contrato: o modelo que a REGRA associa ao tipo do contrato, filtrado pelas condições sobre os
 * fatos do cadastro. O modelo nunca vem da requisição (verificação M5 linha 65): quem chama não escolhe o checklist.
 */
async function resolveRequirementItems(contract, actorUserId, transaction) {
  // A primeira publicação da política padrão (lazy) precisa de autor: quem age ou, em chamada sem ator (job,
  // geração interna), quem criou o contrato. A publicação nunca fica sem autor (rule_publications.published_by NOT NULL).
  const autor = actorUserId || contract.createdBy || contract.updatedBy || null;
  const { action, ruleVersionId } = await resolveRequirementPolicy({ groupId: contract.groupId, companyId: contract.companyId }, autor, transaction);
  const key = action.typeToTemplate[contract.contractType] || null;
  const template = key ? action.templates[key] : null;
  if (!template) return { key, items: null, ruleVersionId, facts: null };
  const facts = await buildFacts(contract, transaction);
  const items = template.filter((item) => !item.when || evaluateNode(item.when, facts)).map((item) => ({ ...item, stage: item.stage || 'LEGAL_REVIEW' }));
  return { key, items, ruleVersionId, facts };
}

module.exports = { RULE_CODE, STAGES, validateAction, publishRequirementRules, resolveRequirementPolicy, resolveRequirementItems, buildFacts };
