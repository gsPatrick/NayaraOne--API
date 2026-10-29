'use strict';

/**
 * M9-D619 — read model rm_legal_deadlines (schema analytics): uma linha por empresa e data-base com os prazos ABERTOS (status PENDING) em três faixas
 * DISJUNTAS do calendário de São Paulo (M9-D660): `due_next_7d` = vencimento de hoje até hoje+6; `due_7_to_29d` = hoje+7 até hoje+29; `overdue` =
 * vencimento antes de hoje, com `oldest_overdue_days` = dias do mais antigo. Vencimento a partir de hoje+30 só conta em `open_total`. O vencimento é a
 * data de calendário do prazo (a conversão para dia útil, quando existe, já está gravada em due_at). Só contagens: partes, teor, advogado e descrição
 * do prazo não entram. Depende do relógio: a agenda recalcula todo dia.
 */
const { sequelize } = require('../../../models');
const { registerReadModel } = require('./readModel.registry');
const { DEADLINE_EVENTS } = require('./juridico.events');
const { asOfAggregateKey, asOfScheduledKeys } = require('./asOf.keys');
const { BUSINESS_TIMEZONE } = require('../../../utils/businessDate');

async function recompute({ companyId, asOfDate, transaction }) {
  const [[row]] = await sequelize.query(
    `WITH d AS (SELECT (due_at AT TIME ZONE :tz)::date AS due FROM legal.legal_deadlines WHERE company_id = :companyId AND deleted_at IS NULL AND status = 'PENDING')
     SELECT (count(*) FILTER (WHERE due BETWEEN CAST(:asOf AS date) AND CAST(:asOf AS date) + 6))::int AS due_next_7d,
            (count(*) FILTER (WHERE due BETWEEN CAST(:asOf AS date) + 7 AND CAST(:asOf AS date) + 29))::int AS due_7_to_29d,
            (count(*) FILTER (WHERE due < CAST(:asOf AS date)))::int AS overdue,
            (CAST(:asOf AS date) - min(due) FILTER (WHERE due < CAST(:asOf AS date)))::int AS oldest_overdue_days,
            (count(*))::int AS open_total,
            (count(*) FILTER (WHERE due IS NULL))::int AS without_date
       FROM d`,
    { replacements: { companyId, asOf: asOfDate, tz: BUSINESS_TIMEZONE }, transaction }
  );
  return { fields: row };
}

const def = registerReadModel({
  name: 'rm_legal_deadlines',
  version: 1,
  keyColumns: ['as_of_date'],
  eventTypes: [...DEADLINE_EVENTS],
  aggregateKey: asOfAggregateKey,
  recompute,
  scheduled: { keys: asOfScheduledKeys },
  rebuild: { keys: asOfScheduledKeys },
});

module.exports = { def, recompute };
