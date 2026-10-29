'use strict';

const { getSetting } = require('../../../settings/settings.service');
const S = require('./consumers.settings');
const { pathMatcher } = require('./target');
const { inTenantTx } = require('./tenantTx');
const deprecationsRepo = require('./deprecations.repository');

/**
 * Contexto de API por empresa guardado na memória do processo (M9-D841 §3.3): deprecações que valem (com o casador de caminho já montado), o intervalo de gravação do uso, a chave do
 * front web e os consumidores já consultados. Vale `governanca.api.deprecacao.cache_segundos`; quem grava (anunciar, cancelar, cadastrar consumidor) limpa o da empresa no mesmo processo.
 */
const cache = new Map();

async function load(tenant, now) {
  return inTenantTx(tenant, async (transaction) => {
    const read = (key) => getSetting(key, tenant, transaction, S.CONSUMERS_SETTING_DEFAULTS[key]);
    const rows = await deprecationsRepo.listActive(tenant.companyId, transaction);
    const cacheSeconds = Number(await read(S.CACHE_SECONDS_KEY));
    return {
      tenant,
      expiresAt: now + cacheSeconds * 1000,
      usageIntervalMinutes: Number(await read(S.USAGE_MINUTES_KEY)),
      webAppKey: String(await read(S.WEB_APP_KEY)),
      deprecations: rows.map((row) => ({ ...row, announcedMs: new Date(row.announcedAt).getTime(), sunsetMs: new Date(row.sunsetAt).getTime(), match: matcherOf(row.target) })),
      consumers: new Map(),
    };
  });
}

function matcherOf(target) {
  const major = /^MAJOR:(\d+)$/.exec(target);
  if (major) return { major: Number(major[1]) };
  const route = /^ROUTE:([A-Z]+) (\/.*)$/.exec(target);
  return { method: route[1], regex: pathMatcher(route[2]) };
}

async function contextFor(tenant, now = Date.now()) {
  const cached = cache.get(tenant.companyId);
  if (cached && cached.expiresAt > now) return cached;
  const fresh = await load(tenant, now);
  cache.set(tenant.companyId, fresh);
  return fresh;
}

/** Limpa o contexto de uma empresa (ou de todas, sem argumento). */
const clearContextCache = (companyId) => { if (companyId) cache.delete(companyId); else cache.clear(); };

module.exports = { contextFor, clearContextCache };
