'use strict';

// Apoio dos testes M9-D904 com banco (não é teste). Rodar SEMPRE em banco descartável (scripts/withDisposableDb.js). Estes testes COMMITAM dados (usuários de setor, flags, parâmetros):
// cada teste limpa o que criou com `cleanup`.
const env = require('./m9d903Env');
const blockersProviders = require('../../../src/features/migration-v2/control/blockers.providers');
const canary = require('../../../src/features/migration-v2/canary/canary.service');
const { upsertSetting } = require('../../../src/features/settings/settings.service');

const { openTenantTx, adminQuery } = env;
const tenantOf = (tenant) => ({ groupId: tenant.groupId, companyId: tenant.companyId, userId: tenant.userId });
const ROLE_PREFIX = 'QA-M9 D904';
const created = { users: [], roles: new Map() };

/** Parâmetro da empresa (gravado como o administrador grava, com validação). */
const setParam = (tenant, key, value) => openTenantTx(tenant, (tx) => upsertSetting(key, value, tenantOf(tenant), tenant.userId, tx));

/** Usuários do setor: papel exclusivo do teste mapeado ao setor pelo parâmetro governanca.bcp.setor_por_papel. Devolve os ids (commitados). */
async function addSectorUsers(tenant, sector, count) {
  const roleName = `${ROLE_PREFIX} ${sector}`;
  created.roles.set(sector, [roleName]);
  const map = Object.fromEntries([...created.roles.entries()]);
  await setParam(tenant, 'governanca.bcp.setor_por_papel', JSON.stringify(map));
  const ids = [];
  for (let i = 0; i < count; i += 1) {
     
    const user = await openTenantTx(tenant, (tx) => env.newUser(tenant, tx, { roleName }));
    ids.push(user.id);
    created.users.push(user.id);
  }
  return ids;
}

/** Entidades que pertencem ao setor neste teste (o parâmetro migracao.setor.<setor>.entidades). */
const setEntities = (tenant, sector, names) => setParam(tenant, `migracao.setor.${sector.toLowerCase()}.entidades`, names.join(','));

/** Blocker de uma entidade na Torre (provedor registrado, como as demandas D903/D907/D908 fazem). Devolve a função que o remove. */
function openBlocker(entity, ref = 'qa904-1') {
  return blockersProviders.register(`qa-m9d904-${entity}-${ref}`, async () => [{ code: 'GOV_MIG_QA904', entity, ref, owner: null, detail: { motivo: 'teste' } }]);
}

const advance = (tenant, sector, body = {}) => openTenantTx(tenant, (tx) => canary.advance(tenantOf(tenant), sector, body, tx));
const rollback = (tenant, sector, body = {}) => openTenantTx(tenant, (tx) => canary.rollback(tenantOf(tenant), sector, body, tx));
const status = (tenant) => openTenantTx(tenant, (tx) => canary.status(tenantOf(tenant), tx));
const flagRow = async (tenant, sector) => (await adminQuery('SELECT * FROM governance.config_entries WHERE company_id = $1 AND key = $2', [tenant.companyId, `migracao.setor.${sector.toLowerCase()}.novo_sistema`])).rows[0] || null;
const percentOf = async (tenant, sector) => { const row = await flagRow(tenant, sector); return row ? Number(row.value) : 0; };
const auditOf = async (tenant, action) => (await adminQuery('SELECT * FROM audit.audit_log WHERE company_id = $1 AND action = $2 ORDER BY occurred_at', [tenant.companyId, action])).rows;
const fail = (promise) => promise.then(() => null, (err) => ({ status: err.statusCode, code: err.code, message: err.message, details: err.details }));

/** Apaga o que os testes criaram: flags do canary, parâmetros, papéis e usuários de teste. */
async function cleanup(tenant) {
  await adminQuery("DELETE FROM governance.flag_versions WHERE company_id = $1 AND key LIKE 'migracao.setor.%'", [tenant.companyId]);
  await adminQuery("DELETE FROM governance.config_entries WHERE company_id = $1 AND key LIKE 'migracao.setor.%'", [tenant.companyId]);
  await adminQuery("DELETE FROM core.tenant_settings WHERE company_id = $1 AND (key LIKE 'migracao.setor.%' OR key LIKE 'migracao.canary.%' OR key = 'governanca.bcp.setor_por_papel')", [tenant.companyId]);
  if (created.users.length) {
    await adminQuery('DELETE FROM core.user_memberships WHERE user_id = ANY($1)', [created.users]);
    await adminQuery('DELETE FROM core.users WHERE id = ANY($1)', [created.users]).catch(() => adminQuery("UPDATE core.users SET status = 'INACTIVE' WHERE id = ANY($1)", [created.users]));
  }
  created.users = []; created.roles.clear();
}

module.exports = { ...env, tenantOf, setParam, addSectorUsers, setEntities, openBlocker, advance, rollback, status, flagRow, percentOf, auditOf, fail, cleanup, canary };
