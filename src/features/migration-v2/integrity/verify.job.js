'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../../models');
const { openTenantTx } = require('../../core-governance/data-quality/retention.tenantTx');
const logger = require('../../../utils/logger');
const { verifyBatch } = require('./batch.verify');

const LIMIT = 200;

/**
 * Verifica, um a um e cada qual na sua transação, os lotes APPLIED da empresa (M9-D905 §5: "a verificação roda no job logo depois de o lote ficar APPLIED"). Um lote que
 * falha ao verificar fica APPLIED (é o blocker "lote não verificado" da Torre) e não impede os demais. Devolve [{ batchId, status } | { batchId, error }].
 */
async function verifyPending(tenant, actor) {
  const pending = await openTenantTx(tenant, (transaction) => sequelize.query(
    "SELECT id FROM governance.mig_batches WHERE company_id = :companyId AND status = 'APPLIED' ORDER BY finished_at, id LIMIT :limit",
    { type: QueryTypes.SELECT, transaction, replacements: { companyId: tenant.companyId, limit: LIMIT } }
  ));
  const out = [];
  for (const { id } of pending) {
    try {
       
      const result = await openTenantTx(tenant, (transaction) => verifyBatch(tenant, actor, id, transaction));
      out.push({ batchId: id, status: result.status });
    } catch (err) {
      logger.error({ batchId: id, err: err.message }, 'migration.batch.verify.failed');
      out.push({ batchId: id, error: err.code || 'ERROR' });
    }
  }
  return out;
}

module.exports = { verifyPending };
