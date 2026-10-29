'use strict';

/**
 * M9-D617 / M9-D640 — rm_rental_contracts: contratos de locação por situação (ACTIVE, SUSPENDED, ...) com a quantidade e o valor registrado no contrato (total_value, que é o
 * aluguel mensal vigente, DI-D617-1). Contrato "ativo" é só ACTIVE; SUSPENDED conta à parte. Para o KPI de contratos ativos (M9-D640) cada situação traz também: contratos sem
 * valor de aluguel (without_rent, regra de qualidade), a quantidade e o aluguel por imóvel (by_property) e por proprietário principal (by_owner: maior participação vigente) e os
 * aluguéis distintos com a quantidade de cada um (rent_distribution, a fórmula aplica as faixas de valor do administrador). Agregado: a empresa (poucas linhas).
 */
const { defineAggregateModel } = require('../aggregateModel');
const { params } = require('./support');

const OWNER = `(SELECT po.person_id FROM real_estate.property_owners po WHERE po.company_id = c.company_id AND po.property_id = c.property_id AND po.deleted_at IS NULL
                 AND (po.valid_until IS NULL OR po.valid_until >= CAST(:today AS date)) ORDER BY po.ownership_percent DESC NULLS LAST, po.person_id LIMIT 1)`;

/** { chave: { count, rent } } dos contratos da situação, agrupados pela coluna `column` do CTE k. */
const grouped = (column) => `COALESCE((SELECT jsonb_object_agg(g.k, jsonb_build_object('count', g.n, 'rent', g.r::text))
    FROM (SELECT x.${column}::text AS k, COUNT(*)::int AS n, COALESCE(SUM(x.total_value), 0) AS r FROM k x WHERE x.status = k.status AND x.${column} IS NOT NULL GROUP BY 1) g), '{}'::jsonb)`;

const slice = () => `
  WITH k AS (
    SELECT c.status, c.property_id, c.total_value, ${OWNER} AS owner_id
      FROM legal.contracts c
     WHERE c.company_id = :companyId AND c.deleted_at IS NULL AND c.contract_type IN (:leaseTypes)
  )
  SELECT k.status AS status, COUNT(*)::int AS count, COALESCE(SUM(k.total_value), 0) AS rent_total,
         COUNT(*) FILTER (WHERE k.total_value IS NULL OR k.total_value <= 0)::int AS without_rent,
         ${grouped('property_id')} AS by_property, ${grouped('owner_id')} AS by_owner,
         COALESCE((SELECT jsonb_agg(jsonb_build_object('rent', d.rent::text, 'count', d.n) ORDER BY d.rent)
                     FROM (SELECT x.total_value AS rent, COUNT(*)::int AS n FROM k x WHERE x.status = k.status AND x.total_value > 0 GROUP BY 1) d), '[]'::jsonb) AS rent_distribution
    FROM k GROUP BY k.status`;

module.exports = defineAggregateModel({
  name: 'rm_rental_contracts', keyColumns: ['status'], aggregateColumns: [], keyOf: () => ({}), params, slice, schedule: { kind: 'keys' },
  eventTypes: ['legal.contract.status_changed', 'contract.activated', 'contract.terminated'],
});
