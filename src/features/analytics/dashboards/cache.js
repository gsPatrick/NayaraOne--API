'use strict';

/**
 * M9-D698 (3.3) — cache de resposta dos painéis, por permissão e escopo. Cache de processo com TTL (a implementação pode trocar o repositório,
 * por exemplo por Redis, com `setCacheStore`, sem mudar a chave nem o TTL).
 *
 * Chave = painel | empresa | grupo | período | versão do painel | hash do conjunto de permissões efetivas | recorte de carteira. Nunca se compartilha
 * resposta entre usuários de permissões diferentes: o dado RESTRICTED que sai mascarado ou não conforme a permissão depende desse hash, e mudar a
 * permissão do usuário muda a chave (o cache antigo não serve). TTL: `analytics.cache.ttl_segundos` (padrão 60 s). O evento
 * `analytics.read_model.refreshed` da empresa descarta tudo o que era dela. Falha do cache degrada para a leitura direta, sem erro para o usuário.
 */
const logger = require('../../../utils/logger');
const clock = require('../metrics/clock');
const readModels = require('../read-models');
const { permissionDigest, readCacheTtlSeconds, CACHE_DEFAULTS, CACHE_KEYS } = require('../security');

const clone = (value) => (value === undefined ? value : JSON.parse(JSON.stringify(value)));

/** Repositório em memória do processo. Contrato: get(key, nowMs), set(key, entry), deleteCompany(id), deleteGroup(id), clear(), size(). */
function createMemoryStore() {
  const entries = new Map();
  return {
    get(key, nowMs) {
      const entry = entries.get(key);
      if (!entry) return null;
      if (entry.expiresAt <= nowMs) { entries.delete(key); return null; }
      return entry;
    },
    set(key, entry) { entries.set(key, entry); },
    deleteCompany(companyId) { for (const [k, e] of entries) if (e.companyId === companyId) entries.delete(k); },
    deleteGroup(groupId) { for (const [k, e] of entries) if (e.groupId === groupId) entries.delete(k); },
    clear() { entries.clear(); },
    size: () => entries.size,
  };
}

let store = createMemoryStore();
const stats = { hits: 0, misses: 0, errors: 0 };

/** spec = { dashboardCode, period, version }. */
function buildDashboardCacheKey(ctx, spec) {
  const rowScope = ctx.rowScope || { mode: 'ALL', userIds: [] };
  const scope = rowScope.mode === 'SELF' ? `self:${[...rowScope.userIds].sort().join(',')}` : 'all';
  return ['analytics', 'dashboard', spec.dashboardCode, ctx.companyId, ctx.groupId, spec.period, `v${spec.version}`, permissionDigest(ctx), scope].join('|');
}

function safe(label, fn) {
  try {
    return fn();
  } catch (err) {
    stats.errors += 1;
    logger.warn({ event: 'analytics.cache.degraded', label, err }, '[analytics] cache do BI indisponível: leitura direta');
    return null;
  }
}

/**
 * Devolve a resposta em cache ou chama `compute(ctx)` e guarda. options: { transaction } lê o TTL da empresa; { ttlSeconds } fixa o TTL;
 * sem nenhum dos dois vale o padrão do livro.
 */
async function cached(ctx, spec, compute, options = {}) {
  const key = buildDashboardCacheKey(ctx, spec);
  const nowMs = clock.now().getTime();
  const hit = safe('get', () => store.get(key, nowMs));
  if (hit) { stats.hits += 1; return clone(hit.value); }
  stats.misses += 1;
  const value = await compute(ctx);
  let ttl = options.ttlSeconds;
  if (!ttl) ttl = options.transaction ? await readCacheTtlSeconds(ctx, options.transaction) : CACHE_DEFAULTS[CACHE_KEYS.TTL_SECONDS];
  safe('set', () => store.set(key, { value: clone(value), expiresAt: nowMs + ttl * 1000, companyId: ctx.companyId, groupId: ctx.groupId }));
  return value;
}

/** Troca o repositório (Redis, ou um que falha, no teste); `null` volta ao da memória. */
function setCacheStore(next) { store = next || createMemoryStore(); }
function clearCache() { safe('clear', () => store.clear()); }
const cacheStats = () => ({ ...stats, size: safe('size', () => store.size()) ?? 0 });

// analytics.read_model.refreshed: o refresh de uma empresa (ou do grupo, nas materialized views) descarta as respostas dela.
readModels.onRefreshed(({ companyId, groupId }) => {
  safe('invalidate', () => (companyId ? store.deleteCompany(companyId) : store.deleteGroup(groupId)));
});

module.exports = { cached, buildDashboardCacheKey, setCacheStore, clearCache, cacheStats };
