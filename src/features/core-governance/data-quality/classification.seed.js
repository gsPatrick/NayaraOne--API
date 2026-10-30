'use strict';

const { getSetting } = require('../../settings/settings.service');
const policyService = require('./retention.policy.service');
const targets = require('./retention.targets');
const inventory = require('./classification.inventory');
const rules = require('./classification.rules');
const repository = require('./classification.repository');
const settings = require('./classification.settings');
const { REVIEW_DEFAULT } = require('./retention.constants');
const { TECHNICAL_DOMAIN } = require('./classification.constants');

/**
 * Semeia o registro da empresa a partir do inventário versionado (M9-D910 §3.2): classificação automática pelas regras (palavras dos parâmetros) mais os overrides do
 * arquivo; a política de retenção vem do tipo de dado (M9-D911 §3.2: tabelas fiscais, de contrato, de processo jurídico, de lead, de log e de auditoria recebem a
 * política do seu tipo) e TODAS as demais colunas recebem a política semeada REVIEW_DEFAULT. Idempotente: nunca sobrescreve o ajuste do steward.
 */
function policyResolver(policies) {
  const byTable = new Map();
  for (const policy of policies) {
    for (const code of policy.dataTypes) {
      const target = targets.get(code);
      if (target) for (const table of targets.tablesOf(target)) byTable.set(table, policy);
    }
  }
  const fallback = policies.find((policy) => policy.code === REVIEW_DEFAULT);
  return {
    policyIdOf: (schema, table) => (byTable.get(`${schema}.${table}`) || fallback).id,
    policyCodeOf: (schema, table) => (byTable.get(`${schema}.${table}`) || fallback).code,
    fallback,
  };
}

async function readLists(tenant, transaction) {
  const read = (key) => getSetting(key, tenant, transaction, settings.CLASSIFICATION_SETTING_DEFAULTS[key]);
  return { restricted: settings.parseWords(await read(settings.RESTRICTED_KEY), settings.DEFAULT_RESTRICTED), high: settings.parseWords(await read(settings.HIGH_KEY), settings.DEFAULT_HIGH) };
}

/** Linhas calculadas de todas as colunas do inventário (sem tocar o banco). */
function buildRows(data, lists, resolver) {
  const out = [];
  for (const [tableKey, columns] of Object.entries(data.columns)) {
    const [schema, table] = tableKey.split('.');
    for (const column of columns) {
      const attrs = { ...rules.attributesOf(schema, table, column, lists), ...(data.overrides[inventory.keyOf(schema, table, column)] || {}) };
      out.push({
        schema_name: schema, table_name: table, column_name: column, entity: table, classification: attrs.classification, purpose: attrs.purpose, policy_id: resolver.policyIdOf(schema, table),
        masking: attrs.masking, mask_pattern: attrs.maskPattern ?? null, exportability: attrs.exportability, ai_allowed: attrs.aiAllowed, owner_domain: attrs.ownerDomain || TECHNICAL_DOMAIN,
      });
    }
  }
  return out;
}

/** Garante as políticas e o registro da empresa; devolve quantas linhas nasceram agora. */
async function ensureRegistry(tenant, transaction, data = inventory.read()) {
  const policies = await policyService.ensurePolicies(tenant, transaction);
  const expected = inventory.flatten(data.columns).length;
  if ((await repository.count(tenant, transaction)) >= expected) return 0;
  return repository.insertMissing(tenant, buildRows(data, await readLists(tenant, transaction), policyResolver(policies)), transaction);
}

module.exports = { ensureRegistry, buildRows, policyResolver, readLists };
