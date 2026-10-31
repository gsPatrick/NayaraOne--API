'use strict';

const { registrarAuditoria } = require('../../../engines/audit/auditLog.service');
const errors = require('./ingest.errors');
const runs = require('./run.repository');
const sources = require('./source.repository');
const { ensureSeeded } = require('../seeds/sources.seed');
const { assertRoom } = require('./run.admission');
const { describeScope } = require('./connectors/company.scope');
const { ENTITY_TYPES, normalizeSystem } = require('../externalRefs.input');

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
  const { unfilteredMulti } = await describeScope(tenant, transaction); // legado sem filtro de empresa num grupo com várias recusa antes de enfileirar
  await assertRoom(tenant, { sourceSystem, entity }, transaction);
  const row = await runs.insert(tenant, { sourceSystem, entity, lastDelta: input.lastDelta === true, requestedBy: actor.userId }, transaction);
  await registrarAuditoria({
    groupId: tenant.groupId, companyId: tenant.companyId, actorUserId: actor.userId, action: 'migration.run.queued', entityType: 'MigRun', entityId: row.id,
    afterJson: { sourceSystem, entity, lastDelta: row.last_delta, sources: found.length }, reason: 'Execução da migração solicitada.',
  }, transaction);
  if (unfilteredMulti) {
    await registrarAuditoria({
      groupId: tenant.groupId, companyId: tenant.companyId, actorUserId: actor.userId, action: 'migration.legacy.unfiltered', entityType: 'MigRun', entityId: row.id,
      afterJson: { sourceSystem, entity }, reason: 'Execução sobre o legado inteiro: o grupo tem várias empresas e a exigência do filtro por empresa está desligada.',
    }, transaction);
  }
  return { runId: row.id };
}

module.exports = { createRun };
