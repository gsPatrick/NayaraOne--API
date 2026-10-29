'use strict';

/**
 * M9-D617 / M9-D640 — rm_rental_vacancy (um retrato por empresa e data-base): imóveis locáveis, alugados, suspensos e vagos, e a soma dos dias de vacância. Locável = imóvel não
 * excluído nem inativo, com situação disponível ou alugada, com oferta de locação ou contrato de locação em vigor, e sem obra em andamento. Alugado = contrato ACTIVE; suspenso = só
 * contrato SUSPENDED (conta à parte); vago = nenhum dos dois. Dias vagos = data-base menos o fim do último contrato encerrado (ou o cadastro do imóvel, se nunca alugado), nunca
 * negativo (DI-D617-2). Para o KPI de vacância (M9-D640): status_undefined = imóveis com oferta de locação ou contrato e situação vazia ou fora das conhecidas (regra de qualidade:
 * DEGRADED) e os locáveis e alugados por tipo, bairro e proprietário principal.
 */
const { defineAggregateModel } = require('../aggregateModel');
const { sqlDay } = require('../aggregateModel.sql');
const { params, todayKey } = require('./support');
const { PROPERTY_EVENTS, CONTRACT_EVENTS } = require('./events');
const { rentableWhere } = require('./rentable.sql');

const lease = (status, alias = 'p') => `EXISTS (SELECT 1 FROM legal.contracts c WHERE c.company_id = ${alias}.company_id AND c.property_id = ${alias}.id AND c.deleted_at IS NULL AND c.contract_type IN (:leaseTypes) AND c.status = '${status}')`;
const rentOffer = (alias = 'p') => `EXISTS (SELECT 1 FROM real_estate.property_offers o WHERE o.company_id = ${alias}.company_id AND o.property_id = ${alias}.id AND o.deleted_at IS NULL AND o.offer_type IN ('RENT', 'SEASONAL'))`;
const OWNER = `(SELECT po.person_id::text FROM real_estate.property_owners po WHERE po.company_id = p.company_id AND po.property_id = p.id AND po.deleted_at IS NULL
                 AND (po.valid_until IS NULL OR po.valid_until >= CAST(:today AS date)) ORDER BY po.ownership_percent DESC NULLS LAST, po.person_id LIMIT 1)`;
const KNOWN = "('AVAILABLE', 'RENTED', 'SOLD', 'WITHDRAWN')";

/** { chave: { rentable, rented } } dos locáveis, agrupados pela coluna `column` do CTE rentable (sem valor: NAO_INFORMADO). */
const grouped = (column) => `COALESCE((SELECT jsonb_object_agg(g.k, jsonb_build_object('rentable', g.n, 'rented', g.r))
    FROM (SELECT COALESCE(NULLIF(x.${column}, ''), 'NAO_INFORMADO') AS k, COUNT(*)::int AS n, (COUNT(*) FILTER (WHERE x.rented))::int AS r FROM rentable x GROUP BY 1) g), '{}'::jsonb)`;

const slice = () => `
  WITH rentable AS (
    SELECT p.id, p.created_at, p.property_type::text AS ptype, a.neighborhood::text AS neighborhood, ${OWNER} AS owner_id, ${lease('ACTIVE')} AS rented, ${lease('SUSPENDED')} AS suspended,
           (SELECT MAX(${sqlDay('c.ends_at')}) FROM legal.contracts c WHERE c.company_id = p.company_id AND c.property_id = p.id AND c.deleted_at IS NULL
              AND c.contract_type IN (:leaseTypes) AND c.status IN ('TERMINATED', 'CLOSED')) AS last_end
      FROM real_estate.properties p
      LEFT JOIN real_estate.property_addresses a ON a.id = p.address_id
     WHERE p.company_id = :companyId AND ${rentableWhere('p', { leaseTypes: ':leaseTypes', worksStatuses: ':worksStatuses' }).sql}
  )
  SELECT COUNT(*)::int AS rentable_total, COUNT(*) FILTER (WHERE rented)::int AS rented_total,
         COUNT(*) FILTER (WHERE suspended AND NOT rented)::int AS suspended_total,
         COUNT(*) FILTER (WHERE NOT rented AND NOT suspended)::int AS vacant_total,
         COALESCE(SUM(GREATEST(CAST(:today AS date) - COALESCE(last_end, ${sqlDay('created_at')}), 0)) FILTER (WHERE NOT rented AND NOT suspended), 0)::bigint AS vacant_days_sum,
         (SELECT COUNT(*)::int FROM real_estate.properties q WHERE q.company_id = :companyId AND q.deleted_at IS NULL AND COALESCE(q.publication_status, '') <> 'INACTIVE'
             AND (COALESCE(q.availability_status, '') = '' OR q.availability_status NOT IN ${KNOWN}) AND (${rentOffer('q')} OR ${lease('ACTIVE', 'q')} OR ${lease('SUSPENDED', 'q')})) AS status_undefined,
         ${grouped('ptype')} AS by_type, ${grouped('neighborhood')} AS by_neighborhood, ${grouped('owner_id')} AS by_owner
    FROM rentable`;

module.exports = defineAggregateModel({
  name: 'rm_rental_vacancy', keyColumns: ['as_of_date'], eventTypes: [...PROPERTY_EVENTS, ...CONTRACT_EVENTS], keyOf: todayKey, params, slice, schedule: { kind: 'today' },
});
