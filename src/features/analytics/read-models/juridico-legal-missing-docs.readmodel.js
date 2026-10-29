'use strict';

/**
 * M9-D619 — read model rm_legal_missing_docs (schema analytics): por tipo de exigência documental, quantas exigências de contratos estão PENDENTES (nem
 * atendidas nem dispensadas) e em quantos contratos; a linha 'TODOS' conta os contratos distintos da empresa (um contrato com dois tipos pendentes conta
 * uma vez). Contrato cancelado ou encerrado não entra. O agregado é a empresa inteira. Só contagens e tipos; o documento e as partes não entram.
 */
const { sequelize } = require('../../../models');
const { registerReadModel } = require('./readModel.registry');
const { REQUIREMENT_EVENTS } = require('./juridico.events');
const { companyAggregateKey, companyKeys } = require('./companyAggregate.keys');

const ALL = 'TODOS';

async function recompute({ companyId, transaction }) {
  const [rows] = await sequelize.query(
    `WITH p AS (
       SELECT r.contract_id, r.requirement_type FROM legal.contract_requirements r JOIN legal.contracts c ON c.id = r.contract_id
        WHERE r.company_id = :companyId AND c.company_id = :companyId AND c.deleted_at IS NULL AND c.status NOT IN ('CANCELLED', 'CLOSED') AND r.status = 'PENDING')
     SELECT requirement_type, (count(DISTINCT contract_id))::int AS contracts_missing, (count(*))::int AS requirements_pending FROM p GROUP BY 1
     UNION ALL
     SELECT CAST(:all AS varchar), (count(DISTINCT contract_id))::int, (count(*))::int FROM p HAVING count(*) > 0
     ORDER BY 1`,
    { replacements: { companyId, all: ALL }, transaction }
  );
  return { rows: rows.map(({ requirement_type: type, ...fields }) => ({ key: { requirement_type: type }, fields })) };
}

const def = registerReadModel({
  name: 'rm_legal_missing_docs',
  version: 1,
  keyColumns: ['requirement_type'],
  aggregateColumns: [],
  eventTypes: [...REQUIREMENT_EVENTS],
  aggregateKey: companyAggregateKey,
  recompute,
  rebuild: { keys: companyKeys },
});

module.exports = { def, recompute, ALL };
