'use strict';

/**
 * M9-D617 — rm_rental_repasses (um retrato por empresa e data-base): repasses ao proprietário. Pendente = PENDING ou APPROVED; pago = PAID
 * com pagamento no mês da data-base (SP); vencido = pendente cujo prazo passou (fim do mês de referência + analytics.locacao.repasse_prazo_dias
 * dias). Valores em net_amount, com a contagem de cada grupo. Cancelados não entram. DI-D617-8.
 *
 * M9-D642 — também guarda os DEVIDOS NO PERÍODO (data prevista de 1º do mês de São Paulo até a data-base, inclusive; data prevista futura ainda não é devida) e, desses, os
 * pagos até a data prevista (dia de São Paulo do pagamento <= data prevista), para o % no prazo; e os repasses pendentes, ou pagos no mês, sem data prevista (mês de referência
 * ausente ou inválido), regra de qualidade do KPI: DEGRADED. DI-D642-3.
 */
const { defineAggregateModel } = require('../aggregateModel');
const { sqlMonth, sqlDay } = require('../aggregateModel.sql');
const { params, todayKey } = require('./support');
const { REPASS_EVENTS } = require('./events');

const PENDING = `r.status IN ('PENDING', 'APPROVED')`;
const DUE = `((to_date(r.reference_month || '-01', 'YYYY-MM-DD') + interval '1 month')::date - 1 + :repassDays)`;
const OVERDUE = `${PENDING} AND r.reference_month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$' AND ${DUE} < CAST(:today AS date)`;
const PAID = `r.status = 'PAID' AND r.paid_at IS NOT NULL AND ${sqlMonth('r.paid_at')} = to_char(CAST(:today AS date), 'YYYY-MM')`;
const VALID_MONTH = `r.reference_month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'`;
const SAFE_DUE = `(CASE WHEN ${VALID_MONTH} THEN ${DUE} END)`; // mês de referência inválido não derruba a consulta: sem data prevista
const DUE_IN_PERIOD = `r.status IN ('PENDING', 'APPROVED', 'PAID') AND ${SAFE_DUE} >= date_trunc('month', CAST(:today AS date))::date AND ${SAFE_DUE} <= CAST(:today AS date)`;
const ON_TIME = `${DUE_IN_PERIOD} AND r.status = 'PAID' AND r.paid_at IS NOT NULL AND ${sqlDay('r.paid_at')} <= ${SAFE_DUE}`;
const NO_DUE_DATE = `(${PENDING} OR (${PAID})) AND NOT (r.reference_month IS NOT NULL AND ${VALID_MONTH})`;
const sum = (cond) => `COALESCE(SUM(r.net_amount) FILTER (WHERE ${cond}), 0)`;
const count = (cond) => `COUNT(*) FILTER (WHERE ${cond})::int`;

const slice = () => `
  SELECT ${sum(PENDING)} AS pending, ${sum(PAID)} AS paid, ${sum(OVERDUE)} AS overdue,
         ${count(PENDING)} AS pending_count, ${count(PAID)} AS paid_count, ${count(OVERDUE)} AS overdue_count,
         ${count(DUE_IN_PERIOD)} AS due_count, ${count(ON_TIME)} AS on_time_count, ${count(NO_DUE_DATE)} AS without_due_date
    FROM finance.owner_repasses r
   WHERE r.company_id = :companyId`;

module.exports = defineAggregateModel({
  name: 'rm_rental_repasses', keyColumns: ['as_of_date'], eventTypes: [...REPASS_EVENTS], keyOf: todayKey, params, slice, schedule: { kind: 'today' },
});
