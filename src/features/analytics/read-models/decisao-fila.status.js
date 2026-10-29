'use strict';

/** M9-D709 (3.1) — estado do item na fila a partir do estado cru da fonte: PENDING espera decisão; aprovado/rejeitado/aceito é DECIDED; o resto (vencido, obsoleto, cancelado) é CANCELED. */
const DECIDED = new Set(['APPROVED', 'REJECTED', 'DECIDED', 'EXECUTED', 'ACCEPTED', 'DENIED']);

function queueStatus(raw) {
  const value = String(raw || '').toUpperCase();
  if (value === 'PENDING') return 'PENDING';
  return DECIDED.has(value) ? 'DECIDED' : 'CANCELED';
}

module.exports = { queueStatus };
