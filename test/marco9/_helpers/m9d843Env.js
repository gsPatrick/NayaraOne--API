'use strict';

// Apoio dos testes M9-D843 (não é teste): parâmetros da empresa, janela segura do minuto e limpeza das tabelas da demanda. Rodar SEMPRE em banco descartável.
const env = require('./bcpEnv');
const { upsertSetting } = require('../../../src/features/settings/settings.service');
const { clearLimitCache } = require('../../../src/features/core-governance/api-governance/standards/rateLimit.limits');

const setSetting = async (tenant, key, value) => { await env.inTx(tenant, (tx) => upsertSetting(key, value, env.tenantOf(tenant), tenant.userId, tx)); clearLimitCache(); };
const clearSettings = async (...keys) => { for (const key of keys) await env.adminQuery('DELETE FROM core.tenant_settings WHERE key = $1', [key]); clearLimitCache(); };

/** O contador é de janela fixa por minuto: espera o relógio do banco virar o minuto (segundo <= maxSecond) para o teste ter quase 60 s de folga; sob carga, quem precisa de certeza confere a janela com windowStart antes e depois. */
async function waitSafeWindow(maxSecond = 4) {
  for (;;) {
    const sec = Number((await env.adminQuery("SELECT EXTRACT(SECOND FROM now())::int AS s")).rows[0].s);
    if (sec <= maxSecond) return;
    await new Promise((resolve) => { setTimeout(resolve, 1000); });
  }
}

const windowStart = async () => String((await env.adminQuery("SELECT date_trunc('minute', now())::text AS w")).rows[0].w);
const resetCounters = () => env.adminQuery('DELETE FROM governance.rate_limit_counters');
const countOf = async (scopeKey) => Number(((await env.adminQuery('SELECT COALESCE(sum(count),0)::int AS n FROM governance.rate_limit_counters WHERE scope_key = $1', [scopeKey])).rows[0] || {}).n);
const idemRows = async (companyId, like = '%') => (await env.adminQuery('SELECT * FROM governance.idempotency_keys WHERE company_id = $1 AND scope LIKE $2 ORDER BY created_at', [companyId, like])).rows;
const cleanIdem = () => env.adminQuery('DELETE FROM governance.idempotency_keys');

/** Concede permissões a um perfil guardando as linhas que ESTE teste inseriu (as que já existiam não são tocadas); a função devolvida remove exatamente essas linhas. */
async function grantTracked(roleName, codes) {
  const inserted = [];
  for (const code of codes) {
    const find = () => env.adminQuery('SELECT rp.id FROM core.role_permissions rp JOIN core.roles r ON r.id = rp.role_id JOIN core.permissions p ON p.id = rp.permission_id WHERE r.name = $1 AND p.code = $2', [roleName, code]);
    if ((await find()).rowCount > 0) continue;
    await env.setRolePermission(roleName, code, true);
    inserted.push(...(await find()).rows.map((row) => row.id));
  }
  return async () => { if (inserted.length) await env.adminQuery('DELETE FROM core.role_permissions WHERE id = ANY($1::uuid[])', [inserted]); };
}

module.exports = { ...env, grantTracked, setSetting, clearSettings, waitSafeWindow, windowStart, resetCounters, countOf, idemRows, cleanIdem };
