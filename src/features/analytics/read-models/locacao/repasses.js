'use strict';

/**
 * M9-D617 — rm_rental_repasses (um retrato por empresa e data-base): repasses ao proprietário. Pendente = PENDING ou APPROVED; pago = PAID
 * com pagamento no mês da data-base (SP); vencido = pendente cujo prazo passou (fim do mês de referência + analytics.locacao.repasse_prazo_dias
 * dias). Valores em net_amount, com a contagem de cada grupo. Cancelados não entram. DI-D617-8.
 */
const { defineAggregateModel } = require('../aggregateModel');
const { sqlMonth } = require('../aggregateModel.sql');
const { params, todayKey } = require('./support');
const { REPASS_EVENTS } = require('./events');

const PENDING = `r.status IN ('PENDING', 'APPROVED')`;
const DUE = `((to_date(r.reference_month || '-01', 'YYYY-MM-DD') + interval '1 month')::date - 1 + :repassDays)`;
const OVERDUE = `${PENDING} AND r.reference_month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$' AND ${DUE} < CAST(:today AS date)`;
const PAID = `r.status = 'PAID' AND r.paid_at IS NOT NULL AND ${sqlMonth('r.paid_at')} = to_char(CAST(:today AS date), 'YYYY-MM')`;
const sum = (cond) => `COALESCE(SUM(r.net_amount) FILTER (WHERE ${cond}), 0)`;
const count = (cond) => `COUNT(*) FILTER (WHERE ${cond})::int`;

const slice = () => `
  SELECT ${sum(PENDING)} AS pending, ${sum(PAID)} AS paid, ${sum(OVERDUE)} AS overdue,
         ${count(PENDING)} AS pending_count, ${count(PAID)} AS paid_count, ${count(OVERDUE)} AS overdue_count
    FROM finance.owner_repasses r
   WHERE r.company_id = :companyId`;

module.exports = defineAggregateModel({
  name: 'rm_rental_repasses', keyColumns: ['as_of_date'], eventTypes: [...REPASS_EVENTS], keyOf: todayKey, params, slice, schedule: { kind: 'today' },
});
