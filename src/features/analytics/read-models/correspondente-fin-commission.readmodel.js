'use strict';

/**
 * M9-D619 — read model rm_fin_commission (schema analytics): por provider, a comissão ESPERADA (direito registrado, ainda não confirmado), a CONFIRMADA
 * (confirmada pelo provider, a receber ou já recebida) e a RECEBIDA, em três colunas separadas (esperada ESTIMATED, confirmada PLANNED, recebida ACTUAL,
 * M9-D610); a diferença confirmada − recebida é o que falta receber. Direito ajustado não conta. O agregado é a empresa inteira. Só valores e código do
 * provider; corretor, solicitante e imóvel não entram.
 */
const { sequelize } = require('../../../models');
const { registerReadModel } = require('./readModel.registry');
const { COMMISSION_EVENTS } = require('./juridico.events');
const { companyAggregateKey, companyKeys } = require('./companyAggregate.keys');

async function recompute({ companyId, transaction }) {
  const [rows] = await sequelize.query(
    `SELECT provider_code AS provider,
            COALESCE(SUM(amount) FILTER (WHERE status = 'EXPECTED'), 0)::text AS expected,
            COALESCE(SUM(amount) FILTER (WHERE status IN ('CONFIRMED', 'RECEIVABLE', 'RECEIVED')), 0)::text AS confirmed,
            COALESCE(SUM(amount) FILTER (WHERE status = 'RECEIVED'), 0)::text AS received
       FROM correspondent.commission_entitlements WHERE company_id = :companyId AND status <> 'ADJUSTED' GROUP BY provider_code ORDER BY 1`,
    { replacements: { companyId }, transaction }
  );
  return { rows: rows.map(({ provider, ...fields }) => ({ key: { provider }, fields })) };
}

const def = registerReadModel({
  name: 'rm_fin_commission',
  version: 1,
  keyColumns: ['provider'],
  aggregateColumns: [],
  eventTypes: [...COMMISSION_EVENTS],
  aggregateKey: companyAggregateKey,
  recompute,
  rebuild: { keys: companyKeys },
});

module.exports = { def, recompute };
