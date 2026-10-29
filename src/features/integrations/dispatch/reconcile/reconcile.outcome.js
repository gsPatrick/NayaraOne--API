'use strict';

/**
 * Do status do fornecedor (já normalizado pelo adapter em `mapStatus`) para o destino do envio incerto (M9-D215 3.2): status final de
 * sucesso -> CONFIRMED; status final de recusa ou cancelamento -> FAILED; qualquer outro (em processamento, na fila, pendente) -> SUBMITTED,
 * que o webhook ou a consulta de status levam ao final depois. Os conjuntos são o vocabulário dos status que os adapters devolvem.
 */
const SUCCESS = Object.freeze(['PAID', 'CONFIRMED', 'COMPLETED', 'SIGNED', 'PUBLISHED', 'APPROVED', 'ISSUED', 'AUTHORIZED', 'DELIVERED', 'SETTLED', 'ACTIVE', 'DONE', 'SUCCESS', 'SUCCEEDED', 'LIVE']);
const FAILURE = Object.freeze(['FAILED', 'REJECTED', 'CANCELLED', 'CANCELED', 'DENIED', 'ERROR', 'EXPIRED', 'REFUSED', 'DECLINED', 'REVERSED', 'RETURNED', 'VOIDED']);

function classifyExternalStatus(status) {
  const s = String(status || '').toUpperCase();
  if (SUCCESS.includes(s)) return 'CONFIRMED';
  if (FAILURE.includes(s)) return 'FAILED';
  return 'IN_PROGRESS';
}

module.exports = { classifyExternalStatus, SUCCESS, FAILURE };
