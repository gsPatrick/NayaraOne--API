'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../../models');
const { TABLES } = require('./flags.constants');

const q = (sql, transaction, replacements) => sequelize.query(sql, { type: QueryTypes.SELECT, transaction, replacements });
/** Nome da tabela pela lista branca (nunca vindo da requisição). */
const tableOf = (kind) => TABLES[kind];

const SCOPE_SQL = "COALESCE(scope_ref, '')";

async function findById(tenant, kind, id, transaction, { lock = false } = {}) {
  const rows = await q(`SELECT * FROM ${tableOf(kind)} WHERE id = :id AND company_id = :companyId${lock ? ' FOR UPDATE' : ''}`, transaction, { id, companyId: tenant.companyId });
  return rows[0] || null;
}

/** Procura o id nas duas tabelas (o PATCH do livro não informa o tipo). */
async function findAnywhere(tenant, id, transaction, { lock = false } = {}) {
  for (const kind of Object.keys(TABLES)) {
    const row = await findById(tenant, kind, id, transaction, { lock });
    if (row) return row;
  }
  return null;
}

async function findBySlot(tenant, kind, key, scope, scopeRef, transaction) {
  const rows = await q(
    `SELECT * FROM ${tableOf(kind)} WHERE company_id = :companyId AND key = :key AND scope = :scope AND ${SCOPE_SQL} = :ref`,
    transaction, { companyId: tenant.companyId, key, scope, ref: scopeRef || '' }
  );
  return rows[0] || null;
}

/** A chave já existe em OUTRO tipo (a chave é única entre flags e configurações da empresa). */
async function keyExistsInKind(tenant, kind, key, transaction) {
  const rows = await q(`SELECT 1 AS hit FROM ${tableOf(kind)} WHERE company_id = :companyId AND key = :key LIMIT 1`, transaction, { companyId: tenant.companyId, key });
  return rows.length > 0;
}

async function insert(tenant, kind, e, actorUserId, transaction) {
  const rows = await q(
    `INSERT INTO ${tableOf(kind)} (group_id, company_id, key, kind, value, value_type, allowed_values, owner_user_id, scope, scope_ref, risk, version,
       valid_from, valid_until, temporary, description, is_kill_switch, state, source, updated_by)
     VALUES (:groupId, :companyId, :key, :kind, CAST(:value AS jsonb), :valueType, CAST(:allowed AS jsonb), :owner, :scope, :scopeRef, :risk, 1,
       :validFrom, :validUntil, :temporary, :description, :killSwitch, 'ACTIVE', :source, :actor)
     RETURNING *`,
    transaction, {
      groupId: tenant.groupId, companyId: tenant.companyId, key: e.key, kind, value: JSON.stringify(e.value), valueType: e.valueType,
      allowed: e.allowedValues ? JSON.stringify(e.allowedValues) : null, owner: e.ownerUserId, scope: e.scope, scopeRef: e.scopeRef || null, risk: e.risk,
      validFrom: e.validFrom || null, validUntil: e.validUntil || null, temporary: Boolean(e.temporary), description: e.description || null,
      killSwitch: Boolean(e.isKillSwitch), source: e.source || 'REGISTRY', actor: actorUserId || null,
    }
  );
  return rows[0];
}

/** Grava o novo estado da chave (versão já calculada pelo serviço). */
async function update(tenant, kind, id, e, actorUserId, transaction) {
  const rows = await q(
    `UPDATE ${tableOf(kind)} SET value = CAST(:value AS jsonb), owner_user_id = :owner, scope = :scope, scope_ref = :scopeRef, risk = :risk, version = :version,
       valid_from = :validFrom, valid_until = :validUntil, temporary = :temporary, description = :description, state = :state, updated_by = :actor, updated_at = now()
     WHERE id = :id AND company_id = :companyId RETURNING *`,
    transaction, {
      id, companyId: tenant.companyId, value: JSON.stringify(e.value), owner: e.ownerUserId, scope: e.scope, scopeRef: e.scopeRef || null, risk: e.risk, version: e.version,
      validFrom: e.validFrom || null, validUntil: e.validUntil || null, temporary: Boolean(e.temporary), description: e.description || null, state: e.state, actor: actorUserId || null,
    }
  );
  return rows[0];
}

/** Foto da versão que deixou de valer (valor anterior guardado). */
async function insertVersion(tenant, kind, before, { replacedBy, reason }, transaction) {
  await q(
    `INSERT INTO governance.flag_versions (group_id, company_id, entry_kind, entry_id, key, version, value, scope, scope_ref, risk, owner_user_id, valid_from, valid_until, state, replaced_by, replaced_reason)
     VALUES (:groupId, :companyId, :kind, :id, :key, :version, CAST(:value AS jsonb), :scope, :scopeRef, :risk, :owner, :validFrom, :validUntil, :state, :replacedBy, :reason)
     ON CONFLICT (entry_kind, entry_id, version) DO NOTHING RETURNING id`,
    transaction, {
      groupId: tenant.groupId, companyId: tenant.companyId, kind, id: before.id, key: before.key, version: before.version, value: JSON.stringify(before.value), scope: before.scope,
      scopeRef: before.scope_ref, risk: before.risk, owner: before.owner_user_id, validFrom: before.valid_from, validUntil: before.valid_until, state: before.state, replacedBy: replacedBy || null, reason,
    }
  );
}

const listVersions = (tenant, kind, id, transaction) => q(
  'SELECT version, value, scope, scope_ref, risk, owner_user_id, valid_from, valid_until, state, replaced_by, replaced_reason, created_at FROM governance.flag_versions WHERE company_id = :companyId AND entry_kind = :kind AND entry_id = :id ORDER BY version DESC',
  transaction, { companyId: tenant.companyId, kind, id }
);

/** Lista as chaves da empresa nas duas tabelas, com filtros opcionais. */
async function list(tenant, filter, transaction) {
  const kinds = filter.kind ? [filter.kind] : Object.keys(TABLES);
  const out = [];
  for (const kind of kinds) {
    const where = ['company_id = :companyId'];
    const rep = { companyId: tenant.companyId };
    for (const [col, name] of [['scope', 'scope'], ['risk', 'risk'], ['state', 'state'], ['owner_user_id', 'owner']]) {
      if (filter[name]) { where.push(`${col} = :${name}`); rep[name] = filter[name]; }
    }
    if (filter.key) { where.push('key LIKE :key'); rep.key = `${filter.key.replace(/[%_\\]/g, '\\$&')}%`; }
    out.push(...await q(`SELECT * FROM ${tableOf(kind)} WHERE ${where.join(' AND ')} ORDER BY key, scope, ${SCOPE_SQL}`, transaction, rep));
  }
  return out.sort((a, b) => a.key.localeCompare(b.key));
}

/** Candidatas à resolução de uma chave (as duas tabelas), só da empresa. */
async function candidates(tenant, key, transaction) {
  const out = [];
  for (const kind of Object.keys(TABLES)) out.push(...await q(`SELECT * FROM ${tableOf(kind)} WHERE company_id = :companyId AND key = :key`, transaction, { companyId: tenant.companyId, key }));
  return out;
}

module.exports = { findById, findAnywhere, findBySlot, keyExistsInKind, insert, update, insertVersion, listVersions, list, candidates };
