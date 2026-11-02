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

module.exports = { ...env, setSetting, clearSettings, waitSafeWindow, windowStart, resetCounters, countOf, idemRows, cleanIdem };
