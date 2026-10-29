'use strict';

/**
 * M9-D617 — rm_rental_contracts: contratos de locação por situação (ACTIVE, SUSPENDED, ...) com a quantidade e o valor registrado no
 * contrato (total_value). Contrato "ativo" é só ACTIVE; SUSPENDED conta à parte. Agregado: a empresa (poucas linhas).
 */
const { defineAggregateModel } = require('../aggregateModel');
const { params } = require('./support');

const slice = () => `
  SELECT c.status AS status, COUNT(*)::int AS count, COALESCE(SUM(c.total_value), 0) AS rent_total
    FROM legal.contracts c
   WHERE c.company_id = :companyId AND c.deleted_at IS NULL AND c.contract_type IN (:leaseTypes)
   GROUP BY 1`;

module.exports = defineAggregateModel({
  name: 'rm_rental_contracts', keyColumns: ['status'], aggregateColumns: [], keyOf: () => ({}), params, slice, schedule: { kind: 'keys' },
  eventTypes: ['legal.contract.status_changed', 'contract.activated', 'contract.terminated'],
});
