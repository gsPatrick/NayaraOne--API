'use strict';

const crypto = require('crypto');
const { sequelize, Rule, RuleVersion, RuleScope, RulePublication, TenantSetting } = require('../../models');
const { registrarAuditoria } = require('../../engines/audit/auditLog.service');

/**
 * Multa, juros e carência da cobrança de locação pelo Motor de Regras (livro, bloco de cobrança: "Multa/juros/grace/cadência via
 * Motor de Regras"; M5-A0330). O cálculo do caso de cobrança lê SÓ a ação da versão vigente das regras REG-LOC-001
 * ({ penaltyPercentage, monthlyInterestPercentage }) e REG-LOC-002 ({ graceDays }) — não há percentual de reserva no código.
 *
 * O administrador continua ajustando os números pela aba Cobrança (chaves billing.late_fee_percentage,
 * billing.interest_percentage, billing.grace_period_days, com MFA): cada gravação PUBLICA uma versão nova da regra (versão
 * anterior fechada, nunca editada; auditoria antes/depois). Empresa que já tinha esses números gravados antes desta mudança
 * tem a regra alinhada a eles na primeira cobrança (mesma publicação, auditada) — o valor que valia continua valendo.
 * Regra não publicada para a empresa continua valendo 0 (fail closed), como antes.
 */
const SETTING_TO_RULE = {
  'billing.late_fee_percentage': { code: 'REG-LOC-001', field: 'penaltyPercentage' },
  'billing.interest_percentage': { code: 'REG-LOC-001', field: 'monthlyInterestPercentage' },
  'billing.grace_period_days': { code: 'REG-LOC-002', field: 'graceDays' },
};
const PRECEDENCE_GLOBAL = 7;

async function currentVersion(code, tenant, transaction) {
  const rule = await Rule.findOne({ where: { code, groupId: tenant.groupId, companyId: tenant.companyId }, transaction });
  if (!rule) return { rule: null, version: null };
  const version = await RuleVersion.findOne({ where: { ruleId: rule.id, status: 'PUBLISHED', effectiveUntil: null }, order: [['versionNumber', 'DESC']], transaction });
  return { rule, version };
}

/** Publica versão nova da regra com `patch` aplicado sobre a ação vigente (só se a regra já existe publicada e algo muda). */
async function publishPenaltyPatch(code, patch, tenant, actorUserId, transaction, reason) {
  if (!actorUserId) return null; // publicação sempre tem autor (rule_publications.published_by_user_id)
  await sequelize.query('SELECT pg_advisory_xact_lock(hashtextextended(:k, 0))', { replacements: { k: `billing_penalty_rule:${tenant.companyId}:${code}` }, transaction });
  const { rule, version } = await currentVersion(code, tenant, transaction);
  if (!rule || !version) return null;
  const action = { ...(version.actionJson || {}), ...patch };
  if (Object.keys(patch).every((k) => Number(version.actionJson && version.actionJson[k]) === Number(patch[k]))) return null;
  const now = new Date();
  await RuleVersion.update({ effectiveUntil: new Date(now.getTime() - 1), updatedBy: actorUserId || null }, { where: { ruleId: rule.id, status: 'PUBLISHED', effectiveUntil: null }, transaction });
  const last = await RuleVersion.findOne({ where: { ruleId: rule.id }, order: [['versionNumber', 'DESC']], transaction });
  const created = await RuleVersion.create({
    groupId: tenant.groupId, companyId: tenant.companyId, ruleId: rule.id, versionNumber: last.versionNumber + 1, conditionAstJson: version.conditionAstJson,
    contentHash: crypto.createHash('sha256').update(JSON.stringify(version.conditionAstJson)).digest('hex'), actionJson: action,
    effectiveFrom: now, effectiveUntil: null, status: 'PUBLISHED', publishedByUserId: actorUserId || null, createdBy: actorUserId || null, updatedBy: actorUserId || null,
  }, { transaction });
  await RuleScope.create({ groupId: tenant.groupId, companyId: tenant.companyId, ruleVersionId: created.id, scopeType: 'GLOBAL', scopeRefId: null, precedence: PRECEDENCE_GLOBAL, createdBy: actorUserId || null, updatedBy: actorUserId || null }, { transaction });
  await RulePublication.create({ groupId: tenant.groupId, companyId: tenant.companyId, ruleVersionId: created.id, publishedByUserId: actorUserId || null, publishedAt: now, createdBy: actorUserId || null, updatedBy: actorUserId || null }, { transaction });
  await registrarAuditoria(
    {
      groupId: tenant.groupId, companyId: tenant.companyId, actorUserId, action: 'billing.penalty_rule.publish', entityType: 'RuleVersion', entityId: created.id,
      beforeJson: { ruleCode: code, versionNumber: version.versionNumber, action: version.actionJson }, afterJson: { ruleCode: code, versionNumber: created.versionNumber, action },
      reason,
    },
    transaction
  );
  return created;
}

/** Gancho da gravação da configuração (settings.service afterWrite): o número gravado vira versão nova da regra. */
async function publishFromSetting(key, value, tenant, actorUserId, transaction) {
  const target = SETTING_TO_RULE[key];
  if (!target) return null;
  return publishPenaltyPatch(target.code, { [target.field]: Number(value) }, tenant, actorUserId, transaction, `Configuração "${key}" alterada para ${value}: nova versão de ${target.code}.`);
}

/** Alinha as regras aos números já gravados pela empresa (idempotente: não publica nada se já batem). */
async function syncPenaltyRulesFromSettings(tenant, actorUserId, transaction) {
  const rows = await TenantSetting.findAll({ where: { companyId: tenant.companyId, key: Object.keys(SETTING_TO_RULE) }, transaction });
  const patches = {};
  for (const row of rows) {
    const value = Number(row.value);
    if (!Number.isFinite(value)) continue;
    const { code, field } = SETTING_TO_RULE[row.key];
    patches[code] = { ...(patches[code] || {}), [field]: value };
  }
  for (const [code, patch] of Object.entries(patches)) {
    await publishPenaltyPatch(code, patch, tenant, actorUserId, transaction, `Regra ${code} alinhada aos números configurados pela empresa (${JSON.stringify(patch)}).`);
  }
}

module.exports = { SETTING_TO_RULE, publishFromSetting, syncPenaltyRulesFromSettings, publishPenaltyPatch };
