'use strict';

/**
 * M9-D617 — rm_rental_arrears (um retrato por empresa e data-base): inadimplência da locação lida do LEDGER (parcelas a receber de
 * contratos de locação), com o mesmo recorte do Financeiro (M9-D615): próprio (não terceiros), sem estorno, PENDING e vencida antes da
 * data-base. A janela (analytics.inadimplencia.janela_dias, padrão 90) separa o vencido que entra na taxa do que fica fora; o valor
 * total vencido não tem limite de idade. billed_90d = faturado (não estornado nem cancelado) na janela até o fim da data-base.
 */
const { defineAggregateModel } = require('../aggregateModel');
const { TODAY_START, DAY_END } = require('../aggregateModel.sql');
const { params, todayKey, LEASE_IDS } = require('./support');
const { ENTRY_EVENTS } = require('./events');

const PENDING_LATE = `f.status = 'PENDING' AND f.due_at < ${TODAY_START}`;
const WINDOW_START = `(${TODAY_START} - make_interval(days => :windowDays - 1))`;

const slice = () => `
  SELECT COALESCE(SUM(f.amount) FILTER (WHERE f.status NOT IN ('REVERSED', 'CANCELLED') AND f.due_at >= ${WINDOW_START} AND f.due_at < ${DAY_END}), 0) AS billed_90d,
         COALESCE(SUM(f.amount) FILTER (WHERE ${PENDING_LATE}), 0) AS overdue_amount,
         COALESCE(SUM(f.amount) FILTER (WHERE ${PENDING_LATE} AND f.due_at >= ${WINDOW_START}), 0) AS overdue_amount_in_window_90d,
         COALESCE(SUM(f.amount) FILTER (WHERE ${PENDING_LATE} AND f.due_at < ${WINDOW_START}), 0) AS overdue_amount_outside_window_90d,
         COUNT(*) FILTER (WHERE ${PENDING_LATE})::int AS overdue_count
    FROM finance.financial_entries f
   WHERE f.company_id = :companyId AND f.nature = 'RECEIVABLE' AND NOT f.is_third_party_funds AND f.reversal_of_entry_id IS NULL
     AND f.contract_id IN ${LEASE_IDS}`;

module.exports = defineAggregateModel({
  name: 'rm_rental_arrears', keyColumns: ['as_of_date'], eventTypes: [...ENTRY_EVENTS], keyOf: todayKey, params, slice, schedule: { kind: 'today' },
});
