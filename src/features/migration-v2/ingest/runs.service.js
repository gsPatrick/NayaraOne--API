'use strict';

const { registrarAuditoria } = require('../../../engines/audit/auditLog.service');
const errors = require('./ingest.errors');
const runs = require('./run.repository');
const sources = require('./source.repository');
const { ensureSeeded } = require('../seeds/sources.seed');
const { getSetting } = require('../../settings/settings.service');
const { KEYS, INGEST_SETTING_DEFAULTS } = require('./ingest.settings');
const { resolveScope } = require('./connectors/company.scope');
const { ENTITY_TYPES, normalizeSystem } = require('../externalRefs.input');

const setting = async (key, tenant, transaction) => Number(await getSetting(key, tenant, transaction, INGEST_SETTING_DEFAULTS[key]));

/** Trava por empresa e fonte e teto da empresa (auditoria M3): serializa o pedido e recusa quando já há execução ativa demais. */
async function assertRoom(tenant, { sourceSystem, entity }, transaction) {
  await runs.lockCompany(tenant, transaction);
  const active = await runs.countActive(tenant, { sourceSystem, entity, expireMinutes: await setting(KEYS.EXEC_EXPIRE_MIN, tenant, transaction) }, transaction);
  if (active.overlapping >= await setting(KEYS.EXEC_PER_SOURCE, tenant, transaction)) throw errors.runAlreadyActive();
  if (active.total >= await setting(KEYS.EXEC_PER_COMPANY, tenant, transaction)) throw errors.runLimit();
}

/**
 * POST /migration/runs (M9-D900 §3.5): registra a execução (QUEUED) para as fontes semeadas — todas, ou só a do `sourceSystem`/`entity` informados — e devolve o runId.
 * Quem executa é o job (e a partida imediata do controlador). `lastDelta` pede, nas fontes WATERMARK, a comparação de chaves que marca as exclusões da origem.
 */
async function createRun(tenant, actor, body, transaction) {
  const input = body || {};
  const sourceSystem = input.sourceSystem === undefined || input.sourceSystem === null ? null : normalizeSystem(input.sourceSystem);
  const entity = input.entity === undefined || input.entity === null ? null : String(input.entity);
  if (entity && !ENTITY_TYPES.includes(entity)) throw errors.runInvalid('Entidade desconhecida para a migração.');
  await ensureSeeded(tenant, transaction);
  const found = await sources.list(tenant, { sourceSystem, entity }, transaction);
  if (!found.length) throw errors.runInvalid('Nenhuma fonte semeada corresponde ao pedido.');
  await resolveScope(tenant, transaction); // legado sem filtro de empresa num grupo com várias recusa antes de enfileirar
  await assertRoom(tenant, { sourceSystem, entity }, transaction);
  const row = await runs.insert(tenant, { sourceSystem, entity, lastDelta: input.lastDelta === true, requestedBy: actor.userId }, transaction);
  await registrarAuditoria({
    groupId: tenant.groupId, companyId: tenant.companyId, actorUserId: actor.userId, action: 'migration.run.queued', entityType: 'MigRun', entityId: row.id,
    afterJson: { sourceSystem, entity, lastDelta: row.last_delta, sources: found.length }, reason: 'Execução da migração solicitada.',
  }, transaction);
  return { runId: row.id };
}

module.exports = { createRun };
