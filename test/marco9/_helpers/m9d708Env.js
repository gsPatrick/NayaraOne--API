'use strict';

// Apoio dos testes da M9-D708 (reconciliação e aceite dos KPIs): reaproveita o ambiente do caixa (duas empresas NOVAS no grupo do seed, relógio
// fixo em 28/10/2026, fontes do Financeiro, refresh e snapshots) e acrescenta o owner (papel + usuário), o arquivo de evidência e a limpeza do
// que a demanda grava. Banco descartável (127.0.0.1).
const crypto = require('node:crypto');
const base = require('./m9d620Env');
const { money } = require('../../../src/features/analytics/metrics/formulas/money');

const OWNER_ROLE = 'financeiro-gestor'; // o owner padrão dos KPIs financeiros é "Diretoria Financeira (papel financeiro-gestor)"
const OTHER_ROLE = 'leitura-m9d708';
const uuid = () => crypto.randomUUID();

async function userByEmail(env, email) {
  const [[u]] = await env.admin.query('SELECT id FROM core.users WHERE email = :email', { replacements: { email } });
  return u.id;
}

async function memberOf(env, t, userId, roleName) {
  const [[existing]] = await env.admin.query('SELECT id FROM core.roles WHERE company_id = :c AND name = :n', { replacements: { c: t.companyId, n: roleName } });
  const roleId = existing ? existing.id : uuid();
  await env.admin.transaction(async (transaction) => {
    await env.admin.query("SET LOCAL session_replication_role = 'replica'", { transaction });
    if (!existing) await env.admin.query('INSERT INTO core.roles (id, group_id, company_id, name, is_system) VALUES (:id, :g, :c, :n, false)', { replacements: { id: roleId, g: t.groupId, c: t.companyId, n: roleName }, transaction });
    await env.admin.query("INSERT INTO core.user_memberships (id, group_id, company_id, user_id, status, role_id) VALUES (gen_random_uuid(), :g, :c, :u, 'ACTIVE', :r)", { replacements: { g: t.groupId, c: t.companyId, u: userId, r: roleId }, transaction });
  });
}

async function setup() {
  const env = await base.setup();
  env.ownerUserId = await userByEmail(env, 'ci-a-gestor@ci.nayaraone.test');
  env.otherUserId = await userByEmail(env, 'ci-a-leitura@ci.nayaraone.test');
  for (const t of [env.cX, env.cY]) {
    await memberOf(env, t, env.ownerUserId, OWNER_ROLE);
    await memberOf(env, t, env.otherUserId, OTHER_ROLE);
  }
  return env;
}

/** Contexto de serviço de um usuário na empresa (permissões dadas; por padrão só o aceite). */
const ctxFor = (t, userId, permissions = ['analytics:accept', 'analytics:read']) => ({ groupId: t.groupId, companyId: t.companyId, actorUserId: userId, permissions });

/** Arquivo de evidência (print ou planilha) da empresa, gravado por superusuário. */
async function evidenceFile(env, t, name = 'conciliacao-caixa-livre.xlsx') {
  const id = uuid();
  await env.admin.query('INSERT INTO people.files (id, group_id, company_id, storage_key, file_name, created_at, updated_at, encrypted_at_rest) VALUES (:id, :g, :c, :k, :n, now(), now(), false)',
    { replacements: { id, g: t.groupId, c: t.companyId, k: `m9d708/${id}`, n: name } });
  env.files = [...(env.files || []), id];
  return id;
}

async function acceptanceRow(env, t, code, version) {
  const [rows] = await env.admin.query('SELECT * FROM analytics.metric_acceptance WHERE company_id = :c AND metric_code = :m AND (CAST(:v AS int) IS NULL OR metric_version = :v) ORDER BY metric_version DESC', { replacements: { c: t.companyId, m: code, v: version || null } });
  if (!rows[0]) return null;
  const two = (v) => (v === null ? null : money(v)); // as colunas são numeric(20,4): os testes comparam em reais com 2 casas
  const r = rows[0];
  return { ...r, bi_value: two(r.bi_value), reference_value: two(r.reference_value), difference: two(r.difference), tolerance: two(r.tolerance) };
}

async function teardown(env) {
  const ids = [env.cX.companyId, env.cY.companyId];
  await env.admin.transaction(async (transaction) => {
    await env.admin.query("SET LOCAL session_replication_role = 'replica'", { transaction });
    for (const t of ['metric_acceptance']) await env.admin.query(`DELETE FROM analytics.${t} WHERE company_id IN (:ids)`, { replacements: { ids }, transaction });
    await env.admin.query('DELETE FROM people.files WHERE company_id IN (:ids)', { replacements: { ids }, transaction });
    await env.admin.query('DELETE FROM core.user_memberships WHERE company_id IN (:ids)', { replacements: { ids }, transaction });
    await env.admin.query('DELETE FROM core.roles WHERE company_id IN (:ids)', { replacements: { ids }, transaction });
  });
  await base.teardown(env);
}

module.exports = { ...base, setup, teardown, ctxFor, evidenceFile, acceptanceRow, OWNER_ROLE, OTHER_ROLE, uuid };
