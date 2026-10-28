'use strict';

const { recordError } = require('../errors/errors.record');

/**
 * Gancho padrão de falha do ciclo (M9-D208, livro 3.2 item 4): grava em integration.integration_errors com origem SYNC
 * e source_ref_id = id do cursor, na MESMA transação que conta a falha. Nunca guarda corpo nem mensagem do provider.
 */
function recordSyncError({ ctx, cursorId, connection, stream, errorCode, consecutiveFailures }, transaction) {
  return recordError(
    ctx,
    {
      providerCode: connection.providerCode,
      connectionId: connection.id,
      source: 'SYNC',
      sourceRefId: cursorId,
      operation: 'sync',
      errorClass: 'UNKNOWN',
      errorCode,
      message: `Falha na sincronização do fluxo ${stream} (${consecutiveFailures} seguida${consecutiveFailures === 1 ? '' : 's'}).`,
    },
    transaction
  );
}

module.exports = { recordSyncError };
