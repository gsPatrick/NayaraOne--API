'use strict';

/**
 * Assinaturas que contam para os portões do contrato (SIGNED e ACTIVE): o pedido eletrônico CANCELLED de quem já tem outra assinatura SIGNED na mesma versão foi substituído
 * pela assinatura manual com evidência (M9-D227 3.3 b) e não bloqueia o contrato. Qualquer outra assinatura cancelada continua contando como não assinada.
 */
function countingSignatures(rows) {
  const assinaram = new Set(rows.filter((s) => s.status === 'SIGNED').map((s) => s.personId));
  return rows.filter((s) => !(s.status === 'CANCELLED' && assinaram.has(s.personId)));
}

module.exports = { countingSignatures };
