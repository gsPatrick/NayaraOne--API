'use strict';

const logger = require('../../../../utils/logger');

/**
 * Efeito do passo REDUCE_LOG_LEVEL: leva o nível de log do processo ao nível configurado enquanto ALGUMA empresa mantiver o passo aplicado. O nível original
 * é guardado na primeira retenção e restaurado quando a última é solta. O passo só muda o nível de log da aplicação; nunca toca infraestrutura.
 */
const holds = new Map();
let baseLevel = null;

function hold(companyId, level) {
  if (baseLevel === null) baseLevel = logger.level;
  const previous = holds.has(companyId) ? holds.get(companyId).previous : logger.level;
  holds.set(companyId, { previous, level });
  logger.level = level;
  return previous;
}

function release(companyId) {
  holds.delete(companyId);
  if (holds.size === 0 && baseLevel !== null) { logger.level = baseLevel; baseLevel = null; return; }
  const last = [...holds.values()].pop();
  if (last) logger.level = last.level;
}

const isHeld = (companyId) => holds.has(companyId);
const heldCount = () => holds.size;

module.exports = { hold, release, isHeld, heldCount };
