'use strict';

const { registrarAuditoria } = require('../../engines/audit/auditLog.service');
const errors = require('./externalRefs.errors');
const repository = require('./externalRefs.repository');
const { parseRegister, normalizeKey, normalizeSystem, normalizeEntityType, normalizeInstant, UUID } = require('./externalRefs.input');

const view = (row, created) => ({
  id: row.id, entityType: row.entity_type, entityId: row.entity_id, sourceSystem: row.source_system, sourceKey: row.source_key, isPrimary: row.is_primary,
  validFrom: row.valid_from, validTo: row.valid_to, migrationRunId: row.migration_run_id, ...(created === undefined ? {} : { created }),
});

const audit = (tenant, actor, action, row, reason, transaction) => registrarAuditoria({
  groupId: tenant.groupId, companyId: tenant.companyId, actorUserId: actor && actor.userId, action, entityType: 'ExternalRef', entityId: row.id,
  afterJson: view(row), reason,
}, transaction);

/** Violação do UNIQUE parcial numa corrida entre dois importadores: vira o mesmo erro da checagem prévia. */
function mapUnique(err) {
  const name = err && err.original && err.original.constraint;
  if (name === 'core_extref_key_uq') return errors.duplicate();
  if (name === 'core_extref_primary_uq') return errors.primaryDuplicate();
  return err;
}

/**
 * Preserva o ID legado de uma entidade (M9-D906 §3). Na MESMA transação do registro migrado. Idempotente: a mesma chave vigente da mesma entidade devolve a linha
 * existente (`created: false`); a mesma chave vigente de outra entidade é 409 GOV_EXTREF_DUPLICATE. `isPrimary` ausente = principal se a entidade ainda não tem um
 * neste sistema; pedir principal quando já existe é 409 GOV_EXTREF_PRIMARY_DUPLICATE.
 */
async function register(tenant, actor, input, transaction) {
  const parsed = parseRegister(input);
  const current = await repository.findCurrentByKey(tenant, parsed, transaction);
  if (current) {
    if (current.entity_id !== parsed.entityId) throw errors.duplicate();
    return view(current, false);
  }
  const hasPrimary = await repository.hasCurrentPrimary(tenant, parsed.entityId, parsed.sourceSystem, transaction);
  const isPrimary = parsed.isPrimary === null ? !hasPrimary : parsed.isPrimary;
  if (isPrimary && hasPrimary) throw errors.primaryDuplicate();
  let row;
  try {
    row = await repository.insert(tenant, parsed, isPrimary, transaction);
  } catch (err) {
    throw mapUnique(err);
  }
  await audit(tenant, actor, 'migration.external_ref.created', row, `Código antigo ${parsed.sourceKey} (${parsed.sourceSystem}) ligado ao registro novo.`, transaction);
  return view(row, true);
}

/**
 * Devolve a entidade que o código antigo apontava em `at` (ausente = agora). Sem `entityType`, o código que vale para mais de um tipo é 409 GOV_EXTREF_AMBIGUOUS;
 * inexistente é 404 GOV_NOT_FOUND.
 */
async function lookup(tenant, sourceSystem, sourceKey, at, options, transaction) {
  const rows = await repository.findAt(tenant, {
    sourceSystem: normalizeSystem(sourceSystem), sourceKey: normalizeKey(sourceKey), at: normalizeInstant(at),
    entityType: options && options.entityType ? normalizeEntityType(options.entityType) : null,
  }, transaction);
  if (!rows.length) throw errors.notFound();
  if (rows.length > 1) throw errors.ambiguous();
  return view(rows[0]);
}

/** Encerra a vigência (valid_to = agora). Nunca apaga. Devolve a linha fechada. */
async function closeRef(tenant, actor, id, transaction) {
  if (!UUID.test(String(id || ''))) throw errors.notFound();
  const row = await repository.close(tenant, id, transaction);
  if (!row) throw errors.notFound();
  await audit(tenant, actor, 'migration.external_ref.closed', row, 'Vigência do código antigo encerrada.', transaction);
  return view(row);
}

/**
 * Reaponta os códigos antigos vigentes de `fromEntityId` para `toEntityId` (merge de duplicatas, M9-D805): fecha cada linha e abre outra para o sobrevivente, com a
 * principal do sistema só quando o sobrevivente ainda não tem uma; o histórico fica. Devolve as linhas abertas.
 */
async function repoint(tenant, actor, { fromEntityId, toEntityId }, transaction) {
  if (!UUID.test(String(fromEntityId || '')) || !UUID.test(String(toEntityId || '')) || fromEntityId === toEntityId) throw errors.entityInvalid();
  const opened = [];
  for (const old of await repository.lockCurrentOfEntity(tenant, fromEntityId, transaction)) {
    const closed = await repository.close(tenant, old.id, transaction);
    await audit(tenant, actor, 'migration.external_ref.closed', closed, 'Código antigo reapontado para o cadastro que ficou após a união.', transaction);
    const hasPrimary = await repository.hasCurrentPrimary(tenant, toEntityId, old.source_system, transaction);
    const row = await repository.insert(tenant, {
      entityType: old.entity_type, entityId: toEntityId, sourceSystem: old.source_system, sourceKey: old.source_key, validFrom: null, migrationRunId: old.migration_run_id,
    }, !hasPrimary, transaction);
    await audit(tenant, actor, 'migration.external_ref.created', row, 'Código antigo reaberto no cadastro que ficou após a união.', transaction);
    opened.push(view(row, true));
  }
  return opened;
}

/** Referência de código antigo nunca é apagada. */
async function remove() {
  throw errors.immutable();
}

module.exports = { register, lookup, closeRef, repoint, remove };
