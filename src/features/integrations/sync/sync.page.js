'use strict';

const { IntegrationSyncCursor } = require('../../../models');
const AppError = require('../../../utils/AppError');
const { auditarCursor, visao } = require('./sync.audit');
const { agoraDoBanco } = require('./sync.lease');
const { tenantTx } = require('./sync.tx');

/**
 * Passo (c) do ciclo: numa ÚNICA transação grava os itens no domínio (idempotente por id externo, responsabilidade
 * de `source.applyItems`) e avança o cursor. Se qualquer coisa falhar, tudo reverte: o cursor nunca passa do que
 * foi gravado (sem perda) e a releitura é segura (sem duplicata). Reconfere o lease: worker que o perdeu não grava.
 */
async function persistPage({ cursorId, workerId, page, source, conexao }, ctx, params) {
  return tenantTx(ctx, async (transaction) => {
    const cursor = await IntegrationSyncCursor.findByPk(cursorId, { transaction, lock: transaction.LOCK.UPDATE });
    if (!cursor || cursor.status !== 'RUNNING' || cursor.leaseOwner !== workerId) {
      throw AppError.conflict('O lease desta sincronização foi assumido por outro worker.', 'INTEGRATION_SYNC_LEASE_LOST');
    }
    const antes = visao(cursor);
    const gravados = page.items.length
      ? Number(await source.applyItems(page.items, { transaction, ctx, connection: conexao })) || 0
      : 0;
    const agora = await agoraDoBanco(transaction);
    if (page.nextCursor !== undefined && page.nextCursor !== null) cursor.cursorValue = String(page.nextCursor);
    if (page.nextWatermark) cursor.highWatermark = new Date(page.nextWatermark);
    cursor.itemsSyncedTotal = String(Number(cursor.itemsSyncedTotal) + gravados);
    cursor.leaseExpiresAt = new Date(agora.getTime() + params.leaseS * 1000);
    await cursor.save({ transaction });
    await auditarCursor(ctx, antes, cursor, `Cursor avançado junto com ${gravados} item(ns) gravado(s).`, transaction);
    return gravados;
  });
}

module.exports = { persistPage };
