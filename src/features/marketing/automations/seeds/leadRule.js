'use strict';

const crypto = require('node:crypto');
const { Rule, RuleVersion, RuleScope, RulePublication } = require('../../../../models');

const CONTACT_RULE_CODE = 'lead.has_contact_channel';
const CONTACT_RULE_AST = Object.freeze({ fact: 'hasContactChannel', op: '==', value: true });
const GLOBAL_PRECEDENCE = 7; // escopo GLOBAL no Motor de Regras (o mais geral)
const MINUTE = 60000;

/**
 * Garante a regra `lead.has_contact_channel` (M9-D420: condição da confirmação de lead novo) no Motor de Regras da empresa: verdadeira quando a pessoa tem WhatsApp, telefone ou
 * e-mail (fact `hasContactChannel`, montado pelo buildAutomationFacts). Regra já existente é mantida como está (quem a alterou, publicou versão nova). Devolve a regra.
 */
async function ensureContactChannelRule({ tenant, actor }, transaction) {
  const existing = await Rule.findOne({ where: { code: CONTACT_RULE_CODE, companyId: tenant.companyId }, transaction });
  if (existing) return existing;
  const base = { groupId: tenant.groupId, companyId: tenant.companyId, createdBy: actor || null, updatedBy: actor || null };
  const rule = await Rule.create({ ...base, code: CONTACT_RULE_CODE, name: 'Lead com canal de contato', description: 'Verdadeira quando a pessoa tem WhatsApp, telefone ou e-mail cadastrado (M9-D420).', domain: 'marketing' }, { transaction });
  const effectiveFrom = new Date(Date.now() - MINUTE);
  const version = await RuleVersion.create({
    ...base, ruleId: rule.id, versionNumber: 1, conditionAstJson: CONTACT_RULE_AST, contentHash: crypto.createHash('sha256').update(JSON.stringify(CONTACT_RULE_AST)).digest('hex'), actionJson: {},
    effectiveFrom, effectiveUntil: null, status: 'PUBLISHED', publishedByUserId: actor || null,
  }, { transaction });
  await RuleScope.create({ ...base, ruleVersionId: version.id, scopeType: 'GLOBAL', scopeRefId: null, precedence: GLOBAL_PRECEDENCE }, { transaction });
  await RulePublication.create({ ...base, ruleVersionId: version.id, publishedByUserId: actor || null, publishedAt: effectiveFrom }, { transaction });
  return rule;
}

module.exports = { ensureContactChannelRule, CONTACT_RULE_CODE };
