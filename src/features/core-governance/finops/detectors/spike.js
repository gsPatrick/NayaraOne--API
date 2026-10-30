'use strict';

const { divHalfEven } = require('../money');

/**
 * Pico contra a média móvel (logs e egress, M9-D862 §3.2 e §3.5). `today` e `history` são BigInt na escala 1e6 (`history`: um valor por dia observado nos
 * N dias anteriores). Dia sem histórico ou com média zero não tem referência: não há achado (nunca inventa média). Compara em inteiros: hoje > fator x média.
 * Devolve { average, excess } (BigInt) ou null.
 */
function detectSpike(today, history, factor) {
  if (!history.length) return null;
  const average = divHalfEven(history.reduce((sum, v) => sum + v, 0n), history.length);
  if (average <= 0n || today <= BigInt(factor) * average) return null;
  return { average, excess: today - average };
}

/** BigInt escala 1e6 -> texto decimal com 6 casas. */
const scaledText = (v) => `${v / 1000000n}.${String(v % 1000000n).padStart(6, '0')}`;

module.exports = { detectSpike, scaledText };
