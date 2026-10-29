'use strict';

/**
 * M9-D617 — rm_rental_inspections_keys (um retrato por empresa e data-base): vistorias de contratos de locação pendentes (não concluídas
 * nem canceladas) e concluídas; chaves entregues (entrega RELEASED de contrato ACTIVE) e chaves atrasadas (entrega ainda PENDING de contrato
 * assinado ou ativo cuja data de início já passou). DI-D617-5. M9-D641: vistorias pendentes com data prevista anterior ao dia-base (inspections_overdue) e chaves entregues e
 * não devolvidas cuja devolução prevista, o fim do contrato, é anterior ao dia-base (keys_return_overdue) ou não existe (keys_without_return_date). DI-D641-3.
 */
const { defineAggregateModel } = require('../aggregateModel');
const { TODAY_START, sqlDay } = require('../aggregateModel.sql');
const { params, todayKey, LEASE_IDS } = require('./support');
const { INSPECTION_KEY_EVENTS, CONTRACT_EVENTS } = require('./events');

const slice = () => `
  SELECT (SELECT COUNT(*) FROM legal.inspections i WHERE i.company_id = :companyId AND i.deleted_at IS NULL AND i.contract_id IN ${LEASE_IDS}
            AND i.status NOT IN ('COMPLETED', 'CANCELLED', 'CANCELED'))::int AS inspections_pending,
         (SELECT COUNT(*) FROM legal.inspections i WHERE i.company_id = :companyId AND i.deleted_at IS NULL AND i.contract_id IN ${LEASE_IDS}
            AND i.status = 'COMPLETED')::int AS inspections_done,
         (SELECT COUNT(*) FROM legal.key_deliveries k JOIN legal.contracts c ON c.id = k.contract_id AND c.company_id = k.company_id
           WHERE k.company_id = :companyId AND k.deleted_at IS NULL AND k.status = 'RELEASED' AND c.status = 'ACTIVE' AND c.id IN ${LEASE_IDS})::int AS keys_out,
         (SELECT COUNT(*) FROM legal.key_deliveries k JOIN legal.contracts c ON c.id = k.contract_id AND c.company_id = k.company_id
           WHERE k.company_id = :companyId AND k.deleted_at IS NULL AND k.status = 'PENDING' AND c.status IN ('SIGNED', 'ACTIVE') AND c.id IN ${LEASE_IDS}
             AND c.starts_at IS NOT NULL AND c.starts_at < ${TODAY_START})::int AS keys_overdue,
         (SELECT COUNT(*) FROM legal.inspections i WHERE i.company_id = :companyId AND i.deleted_at IS NULL AND i.contract_id IN ${LEASE_IDS}
            AND i.status NOT IN ('COMPLETED', 'CANCELLED', 'CANCELED') AND i.scheduled_at IS NOT NULL AND ${sqlDay('i.scheduled_at')} < CAST(:today AS date))::int AS inspections_overdue,
         (SELECT COUNT(*) FROM legal.key_deliveries k JOIN legal.contracts c ON c.id = k.contract_id AND c.company_id = k.company_id
           WHERE k.company_id = :companyId AND k.deleted_at IS NULL AND k.status = 'RELEASED' AND c.status = 'ACTIVE' AND c.id IN ${LEASE_IDS}
             AND c.ends_at IS NOT NULL AND ${sqlDay('c.ends_at')} < CAST(:today AS date))::int AS keys_return_overdue,
         (SELECT COUNT(*) FROM legal.key_deliveries k JOIN legal.contracts c ON c.id = k.contract_id AND c.company_id = k.company_id
           WHERE k.company_id = :companyId AND k.deleted_at IS NULL AND k.status = 'RELEASED' AND c.status = 'ACTIVE' AND c.id IN ${LEASE_IDS} AND c.ends_at IS NULL)::int AS keys_without_return_date`;

module.exports = defineAggregateModel({
  name: 'rm_rental_inspections_keys', keyColumns: ['as_of_date'], eventTypes: [...INSPECTION_KEY_EVENTS, ...CONTRACT_EVENTS], keyOf: todayKey, params, slice, schedule: { kind: 'today' },
});
