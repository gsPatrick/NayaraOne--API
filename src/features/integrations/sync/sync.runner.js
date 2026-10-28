'use strict';

const AppError = require('../../../utils/AppError');
const { ORIGINS } = require('./sync.constants');
const { readSyncParams } = require('./sync.params');
const { tenantTx } = require('./sync.tx');
const { acquireLease } = require('./sync.lease');
const { persistPage } = require('./sync.page');
const { finishSuccess } = require('./sync.finish');
const { registerFailure } = require('./sync.failure');

/**
 * Ciclo de sincronização retomável (M9-D208, livro seção 4 e teste adversarial da seção 19).
 *
 * `source` é o contrato do fornecedor (o adapter, D209):
 *   fetchPage({ cursorValue, cursorKind, since, pageSize, connection }) -> { items, nextCursor, nextWatermark?, done }
 *   applyItems(items, { transaction, ctx, connection }) -> quantidade NOVA gravada (idempotente pelo id externo)
 * `since` só existe para cursor TIMESTAMP: o cursor menos `integration.sync.overlap_s` (janela de sobreposição).
 *
 * Resultado: { status: IDLE | FAILED | STALLED | SKIPPED | LEASE_LOST, pages, itemsWritten, cursorValue, errorCode? }.
 * Falha da fonte ou do domínio NÃO lança: vira FAILED/STALLED no cursor (o job segue para o próximo fluxo).
 * Lança 409 INTEGRATION_SYNC_ALREADY_RUNNING quando outro worker tem o lease vigente.
 */
function sinceDe(cursorKind, cursorValue, overlapS) {
  if (cursorKind !== 'TIMESTAMP' || !cursorValue) return null;
  const base = new Date(cursorValue);
  return Number.isNaN(base.getTime()) ? null : new Date(base.getTime() - overlapS * 1000);
}

function conferirPagina(page) {
  if (!page || !Array.isArray(page.items)) {
    throw AppError.internal('A fonte devolveu uma página inválida.', 'INTEGRATION_SYNC_PAGE_INVALID');
  }
}

async function runSyncCycle({ connectionId, stream, cursorKind, workerId, origin = ORIGINS.SCHEDULER, recordError }, ctx, source) {
  if (!source || typeof source.fetchPage !== 'function' || typeof source.applyItems !== 'function') {
    throw AppError.internal('Fonte de sincronização sem fetchPage/applyItems.', 'INTEGRATION_SYNC_SOURCE_INVALID');
  }
  const params = await tenantTx(ctx, (transaction) => readSyncParams(ctx, transaction));
  const lease = await acquireLease({ connectionId, stream, cursorKind, workerId, origin }, ctx, params);
  if (lease.skipped) return { status: 'SKIPPED', reason: lease.skipped, pages: 0, itemsWritten: 0, cursorValue: lease.cursor.cursorValue };

  const { cursor, conexao } = lease;
  const connection = { id: conexao.id, providerCode: conexao.providerCode, environment: conexao.environment };
  let cursorValue = cursor.cursorValue;
  let pages = 0;
  let itemsWritten = 0;
  try {
    for (;;) {
      const page = await source.fetchPage({ cursorValue, cursorKind: cursor.cursorKind, since: sinceDe(cursor.cursorKind, cursorValue, params.overlapS), pageSize: params.pageSize, connection });
      conferirPagina(page);
      const avanca = page.nextCursor !== undefined && page.nextCursor !== null && String(page.nextCursor) !== cursorValue;
      if (page.items.length || avanca) {
        itemsWritten += await persistPage({ cursorId: cursor.id, workerId, page, source, conexao: connection }, ctx, params);
        pages += 1;
        if (avanca) cursorValue = String(page.nextCursor);
      }
      if (page.done || !page.items.length || !avanca) break;
    }
  } catch (err) {
    const falha = await registerFailure({ cursorId: cursor.id, workerId, err, conexao, stream, recordError }, ctx, params);
    return { ...falha, pages, itemsWritten, cursorValue };
  }
  const fim = await finishSuccess({ cursorId: cursor.id, workerId }, ctx);
  if (!fim) return { status: 'LEASE_LOST', pages, itemsWritten, cursorValue };
  return { status: 'IDLE', pages, itemsWritten, cursorValue: fim.cursorValue };
}

module.exports = { runSyncCycle, sinceDe };
