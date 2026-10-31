'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../../models');
const { SETTINGS_SCHEMA, upsertSetting } = require('../../settings/settings.service');
const { isPlatformOnly } = require('../../settings/settingPlatform');
const { restrictedPermissionOf } = require('../../settings/settingRestricted');
const E = require('./flags.errors');
const { KEY_RE, KEY_MAX, SOURCES } = require('./flags.constants');
const repo = require('./flags.repository');

const q = (sql, transaction, replacements) => sequelize.query(sql, { type: QueryTypes.SELECT, transaction, replacements });

/** Tipo do registro para uma chave do dicionário de configurações da empresa (SETTINGS_SCHEMA). */
function typeOfSpec(spec) {
  if (spec.type === 'boolean') return { valueType: 'BOOLEAN' };
  if (spec.type === 'integer') return { valueType: 'INTEGER' };
  if (spec.type === 'number') return { valueType: 'DECIMAL' };
  if (Array.isArray(spec.enum) && spec.enum.length) return { valueType: 'ENUM', allowedValues: spec.enum };
  return { valueType: 'STRING' };
}

/** Chave que o registro pode absorver: conhecida, no formato do livro e sem segredo (valor cifrado nunca entra no registro). */
const absorbable = (key) => SETTINGS_SCHEMA[key] && !SETTINGS_SCHEMA[key].encrypted && key.length <= KEY_MAX && KEY_RE.test(key);

/** Valor vivo das configurações da empresa (a fonte de verdade continua em core.tenant_settings; o adaptador só lê). */
async function liveValues(tenant, keys, transaction) {
  const out = new Map();
  if (!keys.length) return out;
  const rows = await q('SELECT key, value FROM core.tenant_settings WHERE company_id = :companyId AND deleted_at IS NULL AND key IN (:keys)', transaction, { companyId: tenant.companyId, keys });
  for (const row of rows) out.set(row.key, row.value);
  return out;
}

/**
 * Absorve as configurações já gravadas da empresa como CONFIG do registro (M9-D870 §3.2.5), sem perder valor: a linha é criada com o valor atual, escopo COMPANY,
 * responsável = quem gravou por último (ou quem pediu a absorção), risco do parâmetro governanca.flags.risco_config_absorvida e versão 1. Idempotente: o que já está no
 * registro não é tocado. O valor segue lido de core.tenant_settings, então getSetting e a tela de Parâmetros continuam funcionando sem mudança.
 */
async function absorbTenantSettings(tenant, actorUserId, params, transaction) {
  const rows = await q('SELECT key, value, created_by, updated_by FROM core.tenant_settings WHERE company_id = :companyId AND deleted_at IS NULL ORDER BY key', transaction, { companyId: tenant.companyId });
  const known = new Set((await q("SELECT key FROM governance.config_entries WHERE company_id = :companyId AND scope = 'COMPANY' AND scope_ref = :ref", transaction, { companyId: tenant.companyId, ref: tenant.companyId })).map((r) => r.key));
  const created = [];
  for (const row of rows) {
    if (!absorbable(row.key) || known.has(row.key)) continue;
    const owner = row.updated_by || row.created_by || actorUserId;
    if (!owner) continue;
    const { valueType, allowedValues } = typeOfSpec(SETTINGS_SCHEMA[row.key]);
    created.push(await repo.insert(tenant, 'CONFIG', {
      key: row.key, value: row.value, valueType, allowedValues: allowedValues || null, ownerUserId: owner, scope: 'COMPANY', scopeRef: tenant.companyId, risk: params.absorbedRisk,
      description: 'Configuração da empresa absorvida pelo registro.', source: SOURCES.TENANT_SETTING,
    }, actorUserId, transaction));
  }
  return created;
}

/** Parâmetro só da plataforma (SETTINGS_SCHEMA `platformOnly`) não muda por aqui: o registro nunca declara a permissão de plataforma (M9-D870 R3-M1). 403 antes de gravar qualquer coisa. */
function assertNotPlatformOnly(key) {
  if (isPlatformOnly(SETTINGS_SCHEMA[key])) throw E.platformOnly();
  // Chaves da NAY (ai:admin) e metas de SLO (integration:manage) têm permissão própria que o registro não declara: só mudam pelas Configurações.
  if (SETTINGS_SCHEMA[key] && restrictedPermissionOf(key)) throw E.keyProtected('Esta chave tem permissão própria (NAY ou integrações): altere-a em Configurações.');
}

/** Grava o valor na configuração da empresa pelo serviço existente (validação do dicionário e trava do dono da regra incluídas). */
const writeThrough = (tenant, key, value, actorUserId, transaction) => upsertSetting(key, value, { groupId: tenant.groupId, companyId: tenant.companyId }, actorUserId, transaction);

module.exports = { liveValues, absorbTenantSettings, writeThrough, absorbable, assertNotPlatformOnly };
