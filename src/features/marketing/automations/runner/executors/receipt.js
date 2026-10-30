'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../../../../models');

/**
 * Recibo da ação (Idempotency-Key dos destinos sem coluna action_key): INSERT ... ON CONFLICT DO NOTHING pelo UNIQUE (empresa, action_key). Devolve
 * { replay: true } quando a chave já foi usada — o destino NÃO é executado de novo (a run pode ter perdido o resultado, o recibo não).
 */
async function claim(ctx, destinationRef = null) {
  const rows = await sequelize.query(
    `INSERT INTO marketing.automation_action_receipts (group_id, company_id, run_id, action_key, action_type, destination_ref)
     VALUES (:g, :c, :run, :key, :type, :ref) ON CONFLICT (company_id, action_key) DO NOTHING RETURNING id`,
    { replacements: { g: ctx.tenant.groupId, c: ctx.tenant.companyId, run: ctx.run.id, key: ctx.entry.action_key, type: ctx.entry.type, ref: destinationRef }, transaction: ctx.transaction, type: QueryTypes.SELECT }
  );
  return { replay: rows.length === 0 };
}

const setDestination = (ctx, ref) => sequelize.query('UPDATE marketing.automation_action_receipts SET destination_ref = :ref WHERE company_id = :c AND action_key = :key',
  { replacements: { ref: String(ref).slice(0, 200), c: ctx.tenant.companyId, key: ctx.entry.action_key }, transaction: ctx.transaction });

const replayed = (ctx) => ({ status: 'OK', providerRef: null, replay: true, detail: `${ctx.entry.type} já executada com esta action_key` });

module.exports = { claim, setDestination, replayed };
