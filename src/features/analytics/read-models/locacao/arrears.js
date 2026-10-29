'use strict';

/**
 * M9-D617 / M9-D640 — rm_rental_arrears (um retrato por empresa e data-base): inadimplência da locação lida do LEDGER (parcelas a receber de contratos de locação), com o mesmo recorte do
 * Financeiro (M9-D615): próprio (não terceiros), sem estorno, PENDING e vencida antes da data-base. A janela (analytics.inadimplencia.janela_dias, padrão 90) separa o vencido que entra
 * na taxa do que fica fora; o valor total vencido não tem limite de idade. billed_90d = faturado (não estornado nem cancelado) na janela até o fim da data-base. Para o KPI de
 * inadimplência da locação (M9-D640): o vencido por dia de vencimento (by_age, com os dias de atraso), por contrato (by_contract) e por imóvel (by_property); as entradas pendentes de
 * locação sem vencimento (without_due_date, regra de qualidade) e o vencido próprio que NÃO é de contrato de locação (unlinked_*, fica só no Financeiro): vencido do Financeiro =
 * vencido da locação + unlinked.
 */
const { defineAggregateModel } = require('../aggregateModel');
const { TODAY_START, DAY_END, sqlDay } = require('../aggregateModel.sql');
const { params, todayKey } = require('./support');
const { ENTRY_EVENTS } = require('./events');

const PENDING_LATE = `e.status = 'PENDING' AND e.due_at < ${TODAY_START}`;
const WINDOW_START = `(${TODAY_START} - make_interval(days => :windowDays - 1))`;
const LATE = `e.lease AND ${PENDING_LATE}`;

/** { chave: { amount, inWindow } } do vencido de locação, agrupado pela coluna `column` do CTE e. */
const grouped = (column) => `COALESCE((SELECT jsonb_object_agg(g.k, jsonb_build_object('amount', g.a::text, 'inWindow', g.w::text))
    FROM (SELECT x.${column}::text AS k, SUM(x.amount) AS a, COALESCE(SUM(x.amount) FILTER (WHERE x.due_at >= ${WINDOW_START}), 0) AS w
            FROM e x WHERE x.lease AND x.status = 'PENDING' AND x.due_at < ${TODAY_START} AND x.${column} IS NOT NULL GROUP BY 1) g), '{}'::jsonb)`;

const slice = () => `
  WITH e AS (
    SELECT f.amount, f.status, f.due_at, f.contract_id, c.property_id, (c.id IS NOT NULL) AS lease
      FROM finance.financial_entries f
      LEFT JOIN legal.contracts c ON c.id = f.contract_id AND c.company_id = f.company_id AND c.deleted_at IS NULL AND c.contract_type IN (:leaseTypes)
     WHERE f.company_id = :companyId AND f.nature = 'RECEIVABLE' AND NOT f.is_third_party_funds AND f.reversal_of_entry_id IS NULL
  )
  SELECT COALESCE(SUM(e.amount) FILTER (WHERE e.lease AND e.status NOT IN ('REVERSED', 'CANCELLED') AND e.due_at >= ${WINDOW_START} AND e.due_at < ${DAY_END}), 0) AS billed_90d,
         COALESCE(SUM(e.amount) FILTER (WHERE ${LATE}), 0) AS overdue_amount,
         COALESCE(SUM(e.amount) FILTER (WHERE ${LATE} AND e.due_at >= ${WINDOW_START}), 0) AS overdue_amount_in_window_90d,
         COALESCE(SUM(e.amount) FILTER (WHERE ${LATE} AND e.due_at < ${WINDOW_START}), 0) AS overdue_amount_outside_window_90d,
         COUNT(*) FILTER (WHERE ${LATE})::int AS overdue_count,
         COALESCE(SUM(e.amount) FILTER (WHERE NOT e.lease AND ${PENDING_LATE}), 0) AS unlinked_amount,
         COUNT(*) FILTER (WHERE NOT e.lease AND ${PENDING_LATE})::int AS unlinked_count,
         COUNT(*) FILTER (WHERE e.lease AND e.status = 'PENDING' AND e.due_at IS NULL)::int AS without_due_date,
         COALESCE((SELECT jsonb_agg(jsonb_build_object('date', d.day::text, 'lateDays', d.late, 'amount', d.a::text, 'count', d.n) ORDER BY d.day)
                     FROM (SELECT ${sqlDay('x.due_at')} AS day, (CAST(:today AS date) - ${sqlDay('x.due_at')})::int AS late, SUM(x.amount) AS a, COUNT(*)::int AS n
                             FROM e x WHERE x.lease AND x.status = 'PENDING' AND x.due_at < ${TODAY_START} GROUP BY 1, 2) d), '[]'::jsonb) AS by_age,
         ${grouped('contract_id')} AS by_contract, ${grouped('property_id')} AS by_property
    FROM e`;

module.exports = defineAggregateModel({
  name: 'rm_rental_arrears', keyColumns: ['as_of_date'], eventTypes: [...ENTRY_EVENTS], keyOf: todayKey, params, slice, schedule: { kind: 'today' },
});
