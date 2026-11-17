'use strict';

/** M9-D696 (3.3) — checks do read model rm_rental_arrears: frescor, conciliação com a fonte, invariante, completude de `due_at`, duplicidade, faixa de linhas e valores não negativos. */
const { declareDomainChecks } = require('./domain.declare');
const { readLocacaoParams } = require('../../read-models/locacao.settings');

// DI-BI2-7 (item 14): o universo é o do read model (locacao/arrears.js, `without_due_date`): recebível próprio, sem estorno, PENDING, de contrato de locação
// (tipos do parâmetro analytics.locacao.tipos_contrato). O lançamento próprio de outra origem é medido pela verificação do Financeiro.

declareDomainChecks({
  model: 'rm_rental_arrears', short: 'rental_arrears', domain: 'RENTAL', metrics: ['rent.delinquency'],
  completeness: { field: 'due_at', sql: `SELECT count(*)::int AS total, count(*) FILTER (WHERE due_at IS NULL)::int AS nulls FROM finance.financial_entries WHERE company_id = :companyId AND nature = 'RECEIVABLE' AND status = 'PENDING'
      AND NOT is_third_party_funds AND reversal_of_entry_id IS NULL
      AND contract_id IN (SELECT lc.id FROM legal.contracts lc WHERE lc.company_id = :companyId AND lc.deleted_at IS NULL AND lc.contract_type IN (:leaseTypes))`,
    replacements: async (ctx) => ({ leaseTypes: (await readLocacaoParams(ctx.scope, ctx.transaction)).leaseTypes }) },
  invariant: { rule: 'em atraso = dentro da janela + fora da janela; contagem >= 0', violation: `overdue_count < 0 OR overdue_amount <> overdue_amount_in_window_90d + overdue_amount_outside_window_90d` },
});
