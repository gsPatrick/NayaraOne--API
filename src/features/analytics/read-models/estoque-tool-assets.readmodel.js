'use strict';

/**
 * M9-D618 — read model rm_tool_assets (schema analytics): uma linha por empresa e data-base com os empréstimos de ferramenta abertos, os em atraso
 * (devolução prevista antes da data-base, calendário de São Paulo), os sem data prevista (o KPI marca DEGRADED, M9-D653) e os patrimônios com ordem de
 * manutenção aberta. Empréstimo aberto = status OPEN ou OVERDUE. Só contagens: a lista de quem está com o quê vai ao drill-down com permissão.
 * Depende do relógio: a agenda recalcula todo dia.
 */
const { sequelize } = require('../../../models');
const { registerReadModel } = require('./readModel.registry');
const { TOOL_EVENTS } = require('./obra.events');
const { asOfAggregateKey, asOfScheduledKeys } = require('./asOf.keys');

async function recompute({ companyId, asOfDate, transaction }) {
  const [[loans]] = await sequelize.query(
    `SELECT (count(*))::int AS loans_open,
            (count(*) FILTER (WHERE due_at IS NOT NULL AND due_at < CAST(:asOf AS date)))::int AS loans_overdue,
            (count(*) FILTER (WHERE due_at IS NULL))::int AS loans_without_due_date
       FROM inventory.tool_loans WHERE company_id = :companyId AND status IN ('OPEN', 'OVERDUE')`,
    { replacements: { companyId, asOf: asOfDate }, transaction }
  );
  const [[maintenance]] = await sequelize.query(
    `SELECT (count(DISTINCT asset_id))::int AS assets_in_maintenance FROM inventory.maintenance_orders WHERE company_id = :companyId AND status = 'OPEN'`,
    { replacements: { companyId }, transaction }
  );
  return { fields: { ...loans, ...maintenance } };
}

const def = registerReadModel({
  name: 'rm_tool_assets',
  version: 1,
  keyColumns: ['as_of_date'],
  eventTypes: [...TOOL_EVENTS],
  aggregateKey: asOfAggregateKey,
  recompute,
  scheduled: { keys: asOfScheduledKeys },
  rebuild: { keys: asOfScheduledKeys },
});

module.exports = { def, recompute };
