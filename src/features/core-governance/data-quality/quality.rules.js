'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../../models');
const { getSetting } = require('../../settings/settings.service');
const settings = require('./quality.settings');
const { RULE_CATALOG } = require('./quality.catalog.constants');

const read = (key, tenant, transaction) => getSetting(key, tenant, transaction, settings.QUALITY_SETTING_DEFAULTS[key]);

/** Configuração que as verificações leem (endereço, mídia mínima, categorias que exigem qualificação). */
async function loadConfig(tenant, transaction, today) {
  return {
    today,
    addressFields: settings.parseAddressFields(await read(settings.ADDRESS_FIELDS_KEY, tenant, transaction)),
    mediaMin: Number(await read(settings.MEDIA_MIN_KEY, tenant, transaction)),
    qualificationCategories: settings.parseCategories(await read(settings.QUALIFICATION_CATEGORIES_KEY, tenant, transaction)),
    reviewSeverity: String(await read(settings.REVIEW_SEVERITY_KEY, tenant, transaction)),
  };
}

/**
 * As regras vigentes da empresa (M9-D806 §3.1): o catálogo padrão com peso, severidade e liga/desliga dos parâmetros do administrador, gravado em
 * governance.quality_rules (semeado por empresa na primeira avaliação e mantido igual aos parâmetros). Devolve todas, ativas ou não.
 */
async function ensureRules(tenant, transaction) {
  const weights = settings.parseWeights(await read(settings.WEIGHTS_KEY, tenant, transaction));
  const severities = settings.parseSeverities(await read(settings.SEVERITIES_KEY, tenant, transaction));
  const disabled = settings.parseDisabled(await read(settings.DISABLED_KEY, tenant, transaction));
  const expected = RULE_CATALOG.map((item) => ({
    code: item.code, entity_type: item.entityType, dimension: item.dimension, severity: severities[item.code] || item.severity,
    weight: weights[item.code] !== undefined ? weights[item.code] : item.weight, expression: item.expression, applies_when: item.appliesWhen, active: !disabled.includes(item.code),
  }));
  const current = new Map((await sequelize.query('SELECT code, severity, weight, active FROM governance.quality_rules WHERE company_id = :companyId', {
    type: QueryTypes.SELECT, transaction, replacements: { companyId: tenant.companyId },
  })).map((row) => [row.code, row]));
  for (const rule of expected) {
    const have = current.get(rule.code);
    if (have && have.severity === rule.severity && have.weight === rule.weight && have.active === rule.active) continue;
    await sequelize.query(
      `INSERT INTO governance.quality_rules (group_id, company_id, code, entity_type, dimension, severity, weight, expression, applies_when, active)
       VALUES (:groupId, :companyId, :code, :entity_type, :dimension, :severity, :weight, :expression, :applies_when, :active)
       ON CONFLICT (company_id, code) DO UPDATE SET severity = EXCLUDED.severity, weight = EXCLUDED.weight, active = EXCLUDED.active, updated_at = now()`,
      { transaction, replacements: { groupId: tenant.groupId, companyId: tenant.companyId, ...rule } }
    );
  }
  return expected;
}

module.exports = { ensureRules, loadConfig };
