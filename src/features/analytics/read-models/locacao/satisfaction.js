'use strict';

/**
 * M9-D617 — rm_rental_satisfaction: por mês (SP) do registro, as respostas de satisfação dos locatários e a soma das notas. O sistema não
 * tem pesquisa de satisfação: cada registro de atendimento (elogio, reclamação, conflito) de pessoa que é parte de contrato de locação
 * conta como uma resposta, com a nota do tipo em analytics.locacao.nota_elogio / nota_reclamacao / nota_conflito (DI-D617-7). A média é da fórmula.
 */
const { defineAggregateModel } = require('../aggregateModel');
const { sqlMonth } = require('../aggregateModel.sql');
const { params, oneRow, LEASE_IDS } = require('./support');
const { FEEDBACK_EVENTS } = require('./events');

const slice = ({ where }) => `
  SELECT ${sqlMonth('fc.created_at')} AS month, COUNT(*)::int AS responses,
         COALESCE(SUM(CASE fc.type WHEN 'COMPLIMENT' THEN :scoreCompliment WHEN 'COMPLAINT' THEN :scoreComplaint ELSE :scoreConflict END), 0)::int AS score_sum
    FROM crm.feedback_cases fc
   WHERE fc.company_id = :companyId AND fc.deleted_at IS NULL
     AND fc.person_id IN (SELECT cp.person_id FROM legal.contract_parties cp WHERE cp.company_id = :companyId AND cp.deleted_at IS NULL AND cp.contract_id IN ${LEASE_IDS})${where({ month: sqlMonth('fc.created_at') })}
   GROUP BY 1`;

async function keyOf(event, { transaction }) {
  const id = (event.payloadJson || event.payload || {}).id;
  if (!id) return null;
  const row = await oneRow(`SELECT ${sqlMonth('created_at')} AS month FROM crm.feedback_cases WHERE id = :id AND company_id = :companyId`, { id, companyId: event.companyId }, transaction);
  return row ? { month: row.month } : null;
}

const keysSql = () => `SELECT DISTINCT ${sqlMonth('created_at')} AS month FROM crm.feedback_cases WHERE company_id = :companyId AND deleted_at IS NULL`;

module.exports = defineAggregateModel({
  name: 'rm_rental_satisfaction', keyColumns: ['month'], eventTypes: [...FEEDBACK_EVENTS], keyOf, params, slice, keysSql, schedule: { kind: 'keys' },
});
