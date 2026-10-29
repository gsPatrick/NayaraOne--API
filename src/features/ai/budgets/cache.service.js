'use strict';

const { registrarAuditoria } = require('../../../engines/audit/auditLog.service');
const repo = require('../readmodels/cacheSupport.readmodel');
const { cachePort } = require('../providers/router/cachePort');
const { readCacheParams } = require('./cache.params');
const { requestHash, scopeKey, cacheKey, sourceDescriptors } = require('./cache.key');
const { checkEligibility } = require('./cache.eligibility');
const E = require('./cache.errors');

const tenantOf = (ctx) => ({ groupId: ctx.groupId, companyId: ctx.companyId });
const SOURCE_FIELDS = ['sourceType', 'sourceRef', 'sourceVersion', 'title', 'clause', 'text', 'values', 'classification', 'effectiveFrom', 'effectiveUntil', 'relevanceScore', 'statusAtRetrieval', 'contentHash', 'retrievedAt'];
const pickSource = (s) => Object.fromEntries(SOURCE_FIELDS.map((f) => [f, s[f] === undefined ? null : s[f]]));

/** Trilha da gravação ou da invalidação (sem o texto guardado: só a identidade da entrada). */
async function audit(ctx, action, entry, before, reason, transaction) {
  const view = (e) => (e ? { key: e.key, agentCode: e.agentCode, agentVersion: e.agentVersion, taskType: e.taskType, expiresAt: e.expiresAt, sources: (e.sourceIds || []).length } : { registro: 'inexistente' });
  await registrarAuditoria({
    groupId: ctx.groupId, companyId: ctx.companyId, actorUserId: ctx.userId || null, action, entityType: 'AiCacheEntry', entityId: entry.id, beforeJson: view(before), afterJson: action === 'AI_CACHE_INVALIDATE' ? { registro: 'removido' } : view(entry), reason,
  }, transaction);
}

/** As fontes guardadas ainda existem no índice, na mesma versão e vigentes? (mudou de versão ou foi revogada = não.) */
async function sourcesStillValid(companyId, entry, now, transaction) {
  const wanted = entry.sourceIds || [];
  if (!wanted.length) return true;
  const active = await repo.activeSourceVersions(companyId, wanted.map((s) => s.r), now, transaction);
  return wanted.every((s) => active.some((a) => a.sourceId === s.r && a.version === s.v));
}

/**
 * Consulta do roteador (porta `cachePort`, M9-D015): `lookup(input, { tenant, transaction })` -> `{ result: { answer, sources, snapshotAt }, key }` ou null.
 * Só responde com o cache ligado, a tarefa na lista `cacheableTaskTypes` da versão do agente, a entrada ainda vigente e todas as fontes
 * guardadas ainda válidas; fonte alterada ou revogada apaga a entrada na hora. A chave tem empresa e permissões: outra empresa ou menos
 * permissão nunca acerta.
 */
async function lookup(input, { tenant, transaction }) {
  const params = await readCacheParams(tenant, transaction);
  if (!params.enabled || !input || !input.agentCode || !Number.isInteger(input.agentVersion)) return null;
  const rule = input.ruleInput || {};
  if (!checkEligibility({ enabled: true, taskType: input.taskType, cacheableTaskTypes: input.cacheableTaskTypes, groundingStatus: 'NOT_APPLICABLE' }).ok) return null;
  const scope = scopeKey({
    companyId: tenant.companyId, agentCode: input.agentCode, agentVersion: input.agentVersion, taskType: input.taskType, permissions: rule.permissions,
    request: requestHash({ taskType: input.taskType, input: rule.input, purpose: rule.purpose }),
  });
  const now = new Date();
  const found = await repo.findLive(tenant.companyId, scope, now, transaction);
  if (!found) return null;
  const entry = found;
  if (!(await sourcesStillValid(tenant.companyId, entry, now, transaction))) {
    await repo.remove(tenant.companyId, entry.id, transaction);
    await audit({ ...tenant, userId: rule.userId }, 'AI_CACHE_INVALIDATE', entry, entry, 'Fonte alterada ou revogada.', transaction);
    return null;
  }
  const value = entry.valueJson;
  return { result: { answer: value.answer, sources: value.sources || [], snapshotAt: value.snapshotAt || null }, key: entry.key };
}

/**
 * Guarda o resultado de um run que acabou de terminar, se elegível (M9-D015). `data`: { agentCode, agentVersion, taskType, cacheableTaskTypes,
 * permissions, input, purpose, answer, sources, groundingStatus, isAction, snapshotAt, providerCode, modelCode }. Devolve { stored, reason, key? }.
 */
async function store(ctx, data, transaction) {
  const params = await readCacheParams(ctx, transaction);
  const verdict = checkEligibility({
    enabled: params.enabled, taskType: data.taskType, cacheableTaskTypes: data.cacheableTaskTypes, sources: data.sources, texts: [data.input, data.purpose, data.answer],
    isAction: data.isAction === true, groundingStatus: data.groundingStatus,
  });
  if (!verdict.ok) return { stored: false, reason: verdict.reason };
  const scope = scopeKey({
    companyId: ctx.companyId, agentCode: data.agentCode, agentVersion: data.agentVersion, taskType: data.taskType, permissions: data.permissions,
    request: requestHash({ taskType: data.taskType, input: data.input, purpose: data.purpose }),
  });
  const key = cacheKey(scope, { sources: data.sources, snapshotAt: data.snapshotAt });
  const now = new Date();
  await repo.removeExpired(ctx.companyId, now, transaction);
  const row = await repo.upsert({
    ...tenantOf(ctx), key, scopeKey: scope, agentCode: String(data.agentCode).toUpperCase(), agentVersion: data.agentVersion, taskType: data.taskType,
    valueJson: { answer: data.answer, sources: data.sources.map(pickSource), snapshotAt: data.snapshotAt ? new Date(data.snapshotAt).toISOString() : null },
    sourceIds: sourceDescriptors(data.sources), providerCode: data.providerCode || null, modelCode: data.modelCode || null, now, expiresAt: new Date(now.getTime() + params.ttlSeconds * 1000),
  }, transaction);
  await audit(ctx, 'AI_CACHE_STORE', row, null, 'Resposta não sensível guardada no cache.', transaction);
  return { stored: true, reason: null, key };
}

/** Leitura de uma entrada pela chave. Chave de outra empresa (ou inexistente) é 404 AI_CACHE_NOT_FOUND. */
async function getByKey(ctx, key, transaction) {
  const entry = await repo.findByKey(ctx.companyId, String(key), transaction);
  if (!entry) throw E.notFound();
  return { key: entry.key, agentCode: entry.agentCode, agentVersion: entry.agentVersion, taskType: entry.taskType, expiresAt: entry.expiresAt, cached: true };
}

/** Liga o cache ao roteador (cachePort.register). Idempotente. */
function registerCache() { cachePort.register(lookup); }
registerCache();

module.exports = { lookup, store, getByKey, registerCache };
