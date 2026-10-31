'use strict';

const { sequelize } = require('../../../models');
const { RECORD } = require('../ingest/ingest.constants');
const { canTransition } = require('../control/record.states');

const RECONCILE_FAILED = 'Reconciliação falhou: o conteúdo no destino difere da origem.';

/** Muda de estado os registros MIGRATED das chaves (as transições MIGRATED -> RECONCILED | QUARANTINED são da máquina de estados da M9-D901; o contador acompanha pelo gatilho). */
async function moveMigrated(tenant, source, keys, to, reason, transaction) {
  if (!canTransition(RECORD.MIGRATED, to)) throw new Error(`Transição não prevista: MIGRATED -> ${to}.`);
  if (!keys.length) return 0;
  const [, meta] = await sequelize.query(
    `UPDATE governance.mig_records SET state = :to, reason = :reason, updated_at = now()
      WHERE company_id = :companyId AND source_system = :system AND entity = :entity AND state = 'MIGRATED' AND source_key IN (:keys)`,
    { transaction, replacements: { companyId: tenant.companyId, system: source.source_system, entity: source.entity, keys, to, reason: reason || null } }
  );
  return meta.rowCount;
}

/** Lote VERIFIED: os registros MIGRATED dele passam a RECONCILED (conferidos contra a origem). */
const promote = (tenant, source, keys, transaction) => moveMigrated(tenant, source, keys, RECORD.RECONCILED, null, transaction);

/** Lote HASH_MISMATCH: só as linhas que a árvore apontou como divergentes vão à quarentena; as demais seguem MIGRATED. */
const quarantine = (tenant, source, keys, transaction) => moveMigrated(tenant, source, keys, RECORD.QUARANTINED, RECONCILE_FAILED, transaction);

module.exports = { promote, quarantine, RECONCILE_FAILED };
