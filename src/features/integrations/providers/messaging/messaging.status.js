'use strict';

/**
 * Status interno normalizado da mensagem (M9-D229 3.1): QUEUED 0, SENT 1, DELIVERED 2, READ 3; FAILED é terminal. Fonte única da regra de
 * "não regride": quem aplica status (webhook, consulta de status, envio) pergunta aqui se o novo vale. Os adapters devolvem só estes nomes.
 */
const STATUS = Object.freeze({ QUEUED: 'QUEUED', SENT: 'SENT', DELIVERED: 'DELIVERED', READ: 'READ', FAILED: 'FAILED' });
const RANK = Object.freeze({ QUEUED: 0, SENT: 1, DELIVERED: 2, READ: 3 });

const isStatus = (s) => Object.prototype.hasOwnProperty.call(STATUS, s);

/**
 * O novo status deve ser aplicado? Sem status atual, sempre. FAILED nunca sai de FAILED; a mensagem já entregue ou lida não vira FAILED
 * (o aparelho a recebeu); fora isso só avança (posição maior). Repetir o mesmo status não muda nada.
 */
function shouldApply(current, next) {
  if (!isStatus(next)) return false;
  if (!current || !isStatus(current)) return true;
  if (current === STATUS.FAILED) return false;
  if (next === STATUS.FAILED) return RANK[current] < RANK.DELIVERED;
  return RANK[next] > RANK[current];
}

module.exports = { STATUS, RANK, isStatus, shouldApply };
