'use strict';

/**
 * M9-D617 — rm_rental_vacancy (um retrato por empresa e data-base): imóveis locáveis, alugados, suspensos e vagos, e a soma dos dias de
 * vacância. Locável = imóvel não excluído nem inativo, com situação disponível ou alugada, com oferta de locação ou contrato de locação em
 * vigor, e sem obra em andamento. Alugado = contrato ACTIVE; suspenso = só contrato SUSPENDED (conta à parte); vago = nenhum dos dois.
 * Dias vagos = data-base menos o fim do último contrato encerrado (ou o cadastro do imóvel, se nunca alugado), nunca negativo (DI-D617-2).
 */
const { defineAggregateModel } = require('../aggregateModel');
const { sqlDay } = require('../aggregateModel.sql');
const { params, todayKey } = require('./support');
const { PROPERTY_EVENTS, CONTRACT_EVENTS } = require('./events');

const lease = (status) => `EXISTS (SELECT 1 FROM legal.contracts c WHERE c.company_id = p.company_id AND c.property_id = p.id AND c.deleted_at IS NULL AND c.contract_type IN (:leaseTypes) AND c.status = '${status}')`;

const slice = () => `
  WITH rentable AS (
    SELECT p.id, p.created_at, ${lease('ACTIVE')} AS rented, ${lease('SUSPENDED')} AS suspended,
           (SELECT MAX(${sqlDay('c.ends_at')}) FROM legal.contracts c WHERE c.company_id = p.company_id AND c.property_id = p.id AND c.deleted_at IS NULL
              AND c.contract_type IN (:leaseTypes) AND c.status IN ('TERMINATED', 'CLOSED')) AS last_end
      FROM real_estate.properties p
     WHERE p.company_id = :companyId AND p.deleted_at IS NULL AND COALESCE(p.publication_status, '') <> 'INACTIVE' AND p.availability_status IN ('AVAILABLE', 'RENTED')
       AND (EXISTS (SELECT 1 FROM real_estate.property_offers o WHERE o.company_id = p.company_id AND o.property_id = p.id AND o.deleted_at IS NULL AND o.offer_type IN ('RENT', 'SEASONAL'))
            OR ${lease('ACTIVE')} OR ${lease('SUSPENDED')})
       AND NOT EXISTS (SELECT 1 FROM construction.projects w WHERE w.company_id = p.company_id AND w.property_id = p.id AND w.deleted_at IS NULL AND w.status IN (:worksStatuses))
  )
  SELECT COUNT(*)::int AS rentable_total, COUNT(*) FILTER (WHERE rented)::int AS rented_total,
         COUNT(*) FILTER (WHERE suspended AND NOT rented)::int AS suspended_total,
         COUNT(*) FILTER (WHERE NOT rented AND NOT suspended)::int AS vacant_total,
         COALESCE(SUM(GREATEST(CAST(:today AS date) - COALESCE(last_end, ${sqlDay('created_at')}), 0)) FILTER (WHERE NOT rented AND NOT suspended), 0)::bigint AS vacant_days_sum
    FROM rentable`;

module.exports = defineAggregateModel({
  name: 'rm_rental_vacancy', keyColumns: ['as_of_date'], eventTypes: [...PROPERTY_EVENTS, ...CONTRACT_EVENTS], keyOf: todayKey, params, slice, schedule: { kind: 'today' },
});
