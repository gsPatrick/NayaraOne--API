'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../../models');
const { readValidQuota } = require('../dispatch/quota/quota.state');
const { readQuotaParams } = require('../dispatch/quota/quota.params');
const { QUEUED_STATUSES } = require('./contingency.constants');

/**
 * Quantos itens a fila pode soltar agora (M9-D226 3.3 item 4, "respeitando a cota", M9-D218): no máximo `drain_batch_size`; se o fornecedor informou a cota, no
 * máximo o que sobra acima da reserva (`reserve_pct` do limite). Sem cota válida, vale só o tamanho do lote.
 */
async function drainBudget(ctx, connectionId, batchSize, now, transaction) {
  const params = await readQuotaParams(ctx, transaction);
  const quota = await readValidQuota(connectionId, now, params.fallbackWaitS, transaction);
  if (!quota || quota.remaining === null || quota.remaining === undefined) return batchSize;
  const reserva = quota.limit > 0 ? Math.ceil((quota.limit * params.reservePct) / 100) : 0;
  return Math.max(0, Math.min(batchSize, quota.remaining - reserva));
}

/**
 * Libera a fila da connection em ORDEM DE CRIAÇÃO: os `budget` itens mais antigos ficam vencidos agora, na ordem em que nasceram (o worker pega pelo vencimento),
 * e o que passa do orçamento segue pelas esperas e pela cota do worker. Devolve os ids liberados, do mais antigo ao mais novo.
 */
async function drainQueue(ctx, connectionId, batchSize, now, transaction) {
  const budget = await drainBudget(ctx, connectionId, batchSize, now, transaction);
  if (budget <= 0) return [];
  const alvo = await sequelize.query(
    `SELECT id FROM "integration"."dispatches" WHERE company_id = :companyId AND connection_id = :connectionId AND status IN (:statuses)
      ORDER BY created_at ASC, id ASC LIMIT :budget FOR UPDATE SKIP LOCKED`,
    { replacements: { companyId: ctx.companyId, connectionId, statuses: QUEUED_STATUSES, budget }, type: QueryTypes.SELECT, transaction },
  );
  const ids = alvo.map((r) => r.id);
  if (!ids.length) return [];
  await sequelize.query(
    `UPDATE "integration"."dispatches" d SET next_attempt_at = CAST(:now AS timestamptz) - interval '1 minute' + (a.pos * interval '1 millisecond')
       FROM unnest(CAST(:ids AS uuid[])) WITH ORDINALITY AS a(id, pos) WHERE d.id = a.id`,
    { replacements: { now, ids: `{${ids.join(',')}}` }, transaction },
  );
  return ids;
}

module.exports = { drainQueue, drainBudget };
