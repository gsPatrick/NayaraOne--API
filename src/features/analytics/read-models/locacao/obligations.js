'use strict';

/**
 * M9-D617 — rm_rental_obligations: obrigações pendentes dos contratos de locação não encerrados, por tipo: REQUIREMENT (exigência
 * documental do contrato ainda PENDING) e UTILITY (troca de titularidade de conta de consumo exigida e sem comprovante). Vencida =
 * o contrato já está ACTIVE e a obrigação continua pendente (a exigência e a troca devem estar cumpridas na ativação). DI-D617-3.
 */
const { defineAggregateModel } = require('../aggregateModel');
const { params } = require('./support');
const { CONTRACT_EVENTS } = require('./events');

const slice = () => `
  SELECT kind, COUNT(*)::int AS pending, COUNT(*) FILTER (WHERE active)::int AS overdue FROM (
    SELECT 'REQUIREMENT' AS kind, (c.status = 'ACTIVE') AS active
      FROM legal.contract_requirements r JOIN legal.contracts c ON c.id = r.contract_id AND c.company_id = r.company_id
     WHERE r.company_id = :companyId AND r.status = 'PENDING' AND c.deleted_at IS NULL AND c.contract_type IN (:leaseTypes) AND c.status NOT IN ('TERMINATED', 'CLOSED')
    UNION ALL
    SELECT 'UTILITY', (c.status = 'ACTIVE')
      FROM finance.utility_obligations u JOIN legal.contracts c ON c.id = u.contract_id AND c.company_id = u.company_id
     WHERE u.company_id = :companyId AND u.deleted_at IS NULL AND u.status = 'ACTIVE' AND u.transfer_required AND u.evidence_file_id IS NULL
       AND c.deleted_at IS NULL AND c.contract_type IN (:leaseTypes) AND c.status NOT IN ('TERMINATED', 'CLOSED')
  ) x GROUP BY 1`;

module.exports = defineAggregateModel({
  name: 'rm_rental_obligations', keyColumns: ['kind'], aggregateColumns: [], keyOf: () => ({}), params, slice, schedule: { kind: 'keys' },
  eventTypes: [...CONTRACT_EVENTS],
});
