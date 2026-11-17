'use strict';

/** M9-D696 (3.3) — checks do read model rm_rental_contracts: frescor, conciliação com a fonte, invariante, completude de `total_value`, duplicidade, faixa de linhas e valores não negativos. */
const { declareDomainChecks } = require('./domain.declare');
const { readLocacaoParams } = require('../../read-models/locacao.settings');

// DI-BI2-7 (item 13): o read model só conta locação (tipos do parâmetro analytics.locacao.tipos_contrato, locacao/contracts.js) e o valor fica congelado de APPROVED
// em diante (TERMS_LOCKED_STATUSES em contract.service.js, lista escrita aqui sem importar o módulo): rascunho, revisão e aditivo/termo ficam fora.
const TERMS_LOCKED = "'APPROVED', 'SIGNING', 'SIGNED', 'ACTIVE', 'SUSPENDED', 'TERMINATED', 'CLOSED'";

declareDomainChecks({
  model: 'rm_rental_contracts', short: 'rental_contracts', domain: 'RENTAL', metrics: ['rent.active_contracts'],
  completeness: { field: 'total_value', sql: `SELECT count(*)::int AS total, count(*) FILTER (WHERE total_value IS NULL)::int AS nulls FROM legal.contracts WHERE company_id = :companyId AND deleted_at IS NULL AND contract_type IN (:leaseTypes) AND status IN (${TERMS_LOCKED})`,
    replacements: async (ctx) => ({ leaseTypes: (await readLocacaoParams(ctx.scope, ctx.transaction)).leaseTypes }) },
  invariant: { rule: 'cada status guardado tem ao menos um contrato', violation: `count < 1` },
});
