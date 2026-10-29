'use strict';

const { sequelize } = require('../../../../models');

/**
 * Ordem dos eventos do mesmo recurso (M9-D212 3.2 item 4): o adapter declara a posição de cada status (`statusRank`). O evento com posição MENOR que a maior já aplicada
 * para o mesmo recurso fica no histórico com applied=false e não chega ao domínio (o pagamento PAID não volta a PROCESSING). Posição igual ou maior é aplicada.
 * A decisão é serializada por recurso (trava de aviso na transação), para dois eventos simultâneos do mesmo recurso não se ultrapassarem.
 * Sem recurso, sem status ou status fora da ordem declarada: sempre aplicado.
 */
async function decideOrder(ctx, row, { ranks, internalStatus, resourceRef }, transaction) {
  const rank = internalStatus && ranks && Number.isInteger(ranks[internalStatus]) ? ranks[internalStatus] : null;
  if (!resourceRef || rank === null) return { applied: true, rank };
  await sequelize.query('SELECT pg_advisory_xact_lock(hashtext(:k))', { replacements: { k: `wh-order|${ctx.companyId}|${row.providerCode}|${resourceRef}` }, transaction });
  const [[linha]] = await sequelize.query(
    `SELECT max(status_rank) AS maior FROM "integration"."webhook_inbox"
      WHERE company_id = :c AND provider_code = :p AND resource_ref = :r AND applied IS TRUE AND id <> :id`,
    { replacements: { c: ctx.companyId, p: row.providerCode, r: resourceRef, id: row.id }, transaction }
  );
  const maior = linha && linha.maior !== null ? Number(linha.maior) : null;
  return { applied: maior === null || rank >= maior, rank };
}

module.exports = { decideOrder };
