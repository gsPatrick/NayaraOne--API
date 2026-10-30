'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../../models');
const { SHARED_COMPANY_KEY } = require('./finops.constants');

const CONFLICT = `(group_id, COALESCE(company_id, '${SHARED_COMPANY_KEY}'::uuid), environment, domain, category, service, period_start, period_end, cost_kind, source_ref)`;

/**
 * Grava uma linha do ledger de forma idempotente (UNIQUE da chave com empresa e domínio). BILLED repetido não muda nada (mesma resposta);
 * ESTIMATED repetido atualiza quantidade e valor da mesma linha (a hora ou o dia reexecutado), sem duplicar. Devolve { id, inserted }.
 */
async function upsertLine(tenant, line, transaction) {
  const estimated = line.costKind === 'ESTIMATED';
  const [row] = await sequelize.query(
    `INSERT INTO governance.cost_ledger (group_id, company_id, environment, domain, category, service, usage_quantity, usage_unit, amount_cents, currency, cost_kind, line_type, period_start, period_end, source_ref)
     VALUES (:groupId, :companyId, :environment, :domain, :category, :service, :usageQuantity, :usageUnit, :amountCents, :currency, :costKind, :lineType, :periodStart, :periodEnd, :sourceRef)
     ON CONFLICT ${CONFLICT} DO UPDATE SET
       ${estimated ? 'usage_quantity = EXCLUDED.usage_quantity, usage_unit = EXCLUDED.usage_unit, amount_cents = EXCLUDED.amount_cents, collected_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP' : 'collected_at = governance.cost_ledger.collected_at'}
     RETURNING id, (xmax = 0) AS inserted`,
    { type: QueryTypes.SELECT, transaction, replacements: { groupId: tenant.groupId, ...line } }
  );
  return { id: row.id, inserted: row.inserted };
}

/** A fatura BILLED (CHARGE) marca como substituídos os ESTIMATED de mesmo escopo cujo período está CONTIDO no período faturado. Devolve os dias afetados. */
async function supersedeContained(tenant, billedId, transaction) {
  return sequelize.query(
    `UPDATE governance.cost_ledger e SET superseded_by = b.id, updated_at = CURRENT_TIMESTAMP
       FROM governance.cost_ledger b
      WHERE b.id = :billedId AND b.cost_kind = 'BILLED' AND b.line_type = 'CHARGE'
        AND e.group_id = b.group_id AND e.company_id IS NOT DISTINCT FROM b.company_id AND e.environment = b.environment AND e.domain = b.domain
        AND e.category = b.category AND e.service = b.service AND e.cost_kind = 'ESTIMATED' AND e.superseded_by IS NULL
        AND e.period_start >= b.period_start AND e.period_end <= b.period_end
      RETURNING e.period_start`,
    { type: QueryTypes.SELECT, transaction, replacements: { billedId } }
  );
}

/** ESTIMATED que chega depois da fatura do período (coleta atrasada) já nasce substituído. */
async function supersedeByExistingBill(estimatedId, transaction) {
  await sequelize.query(
    `UPDATE governance.cost_ledger e SET superseded_by = (
        SELECT b.id FROM governance.cost_ledger b
         WHERE b.cost_kind = 'BILLED' AND b.line_type = 'CHARGE' AND b.group_id = e.group_id AND b.company_id IS NOT DISTINCT FROM e.company_id
           AND b.environment = e.environment AND b.domain = e.domain AND b.category = e.category AND b.service = e.service
           AND b.period_start <= e.period_start AND b.period_end >= e.period_end ORDER BY b.period_start LIMIT 1)
      WHERE e.id = :estimatedId AND e.superseded_by IS NULL`,
    { transaction, replacements: { estimatedId } }
  );
}

module.exports = { upsertLine, supersedeContained, supersedeByExistingBill };
