'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../../models');
const { registrarAuditoria } = require('../../../engines/audit/auditLog.service');
const { BATCH } = require('../ingest/ingest.constants');
const ingestErrors = require('../ingest/ingest.errors');
const batches = require('../ingest/batch.repository');
const sources = require('../ingest/source.repository');
const { getTarget } = require('../ingest/targets');
const { canonicalLine } = require('./canonical');
const { leafHash, merkleRoot } = require('./merkle');
const { loadSchema } = require('./schema.repository');
const { listLeaves, setTargetHashes } = require('./leaves.repository');
const { promote, quarantine } = require('./reconcile');
const errors = require('./integrity.errors');

const MISMATCH_CODE = 'GOV_MIG_HASH_MISMATCH';

/** VERIFIED só com raízes E contagens iguais; qualquer diferença é HASH_MISMATCH. */
function decide({ sourceRoot, targetRoot, sourceCount, targetCount }) {
  return sourceRoot === targetRoot && Number(sourceCount) === Number(targetCount) ? BATCH.VERIFIED : BATCH.HASH_MISMATCH;
}

async function lockBatch(tenant, batchId, transaction) {
  await sequelize.query('SELECT id FROM governance.mig_batches WHERE company_id = :companyId AND id = :id FOR UPDATE', { type: QueryTypes.SELECT, transaction, replacements: { companyId: tenant.companyId, id: batchId } });
  const batch = await batches.get(tenant, batchId, transaction);
  if (!batch) throw ingestErrors.batchNotFound();
  return batch;
}

/** Lado do destino: relê do banco o que foi gravado e calcula a folha de cada chave (nula quando a linha sumiu). Nada é reaproveitado da memória do apply. */
async function targetHashes(tenant, batch, source, schema, leaves, transaction) {
  const keys = leaves.map((leaf) => leaf.source_key);
  const found = keys.length ? await sequelize.query(
    'SELECT source_key, target_entity_id FROM governance.mig_records WHERE company_id = :companyId AND source_system = :system AND entity = :entity AND source_key IN (:keys)',
    { type: QueryTypes.SELECT, transaction, replacements: { companyId: tenant.companyId, system: source.source_system, entity: source.entity, keys } }
  ) : [];
  const targetOf = new Map(found.map((row) => [row.source_key, row.target_entity_id]));
  const rows = await getTarget(source.entity).readCanonical(tenant, [...new Set(found.map((row) => row.target_entity_id).filter(Boolean))], transaction);
  const hashes = new Map();
  for (const key of keys) {
    const row = rows.get(targetOf.get(key));
    hashes.set(key, row ? leafHash(canonicalLine(schema, row)).toString('hex') : null);
  }
  return hashes;
}

/**
 * Verifica um lote APPLIED (M9-D905 §3.3): calcula a raiz Merkle do destino relendo o banco, compara com a da origem (e as contagens) e leva o lote a VERIFIED ou
 * HASH_MISMATCH. VERIFIED promove os registros MIGRATED do lote a RECONCILED; HASH_MISMATCH leva à quarentena só as linhas divergentes (folha a folha). Verificar de novo um
 * lote VERIFIED devolve o mesmo resultado; lote em outro estado: 409 GOV_MIG_BATCH_INVALID_TRANSITION (HASH_MISMATCH só volta a VERIFIED depois de reaplicado).
 */
async function verifyBatch(tenant, actor, batchId, transaction) {
  const batch = await lockBatch(tenant, batchId, transaction);
  if (batch.status === BATCH.VERIFIED) return { batch, status: BATCH.VERIFIED, already: true, divergent: [], promoted: 0, quarantined: 0 };
  if (batch.status !== BATCH.APPLIED) throw ingestErrors.invalidTransition(batch.status, BATCH.VERIFIED);
  const source = await sources.get(tenant, batch.source_id, transaction);
  const schema = await loadSchema(tenant, source.entity, transaction);
  const leaves = await listLeaves(tenant, batch.id, transaction);
  const hashes = await targetHashes(tenant, batch, source, schema, leaves, transaction);
  const present = leaves.filter((leaf) => hashes.get(leaf.source_key));
  const target = merkleRoot(present.map((leaf) => ({ key: leaf.source_key, hash: Buffer.from(hashes.get(leaf.source_key), 'hex') })));
  const verdict = decide({ sourceRoot: batch.source_root, targetRoot: target.root, sourceCount: batch.source_count, targetCount: target.count });
  await setTargetHashes(tenant, batch.id, hashes, transaction);
  const divergent = leaves.filter((leaf) => hashes.get(leaf.source_key) !== leaf.leaf_hash_source).map((leaf) => leaf.source_key);
  const fields = { targetRoot: target.root, targetCount: target.count };
  let promoted = 0;
  let quarantined = 0;
  let done;
  if (verdict === BATCH.VERIFIED) {
    done = await batches.transition(tenant, batch.id, BATCH.VERIFIED, fields, transaction);
    promoted = await promote(tenant, source, leaves.map((leaf) => leaf.source_key), transaction);
  } else {
    done = await batches.transition(tenant, batch.id, BATCH.HASH_MISMATCH, { ...fields, error: `${MISMATCH_CODE}: ${errors.HASH_MISMATCH_MESSAGE} (${divergent.length} linha(s) divergente(s) de ${leaves.length}).` }, transaction);
    quarantined = await quarantine(tenant, source, divergent, transaction);
  }
  await registrarAuditoria({
    groupId: tenant.groupId, companyId: tenant.companyId, actorUserId: actor && actor.userId, action: 'migration.batch.verified', entityType: 'MigBatch', entityId: batch.id,
    afterJson: { status: verdict, sourceRoot: batch.source_root, targetRoot: target.root, sourceCount: batch.source_count, targetCount: target.count, divergent: divergent.slice(0, 50), divergentTotal: divergent.length, promoted, quarantined },
    reason: verdict === BATCH.VERIFIED ? 'Lote verificado: raízes e contagem iguais.' : 'Lote com conteúdo diferente da origem (HASH_MISMATCH).',
  }, transaction);
  return { batch: done, status: verdict, already: false, divergent, promoted, quarantined };
}

module.exports = { verifyBatch, decide, MISMATCH_CODE };
