'use strict';

/**
 * DI-BI2-9 — o que entra no hash do cálculo (calc_hash) do snapshot. O recálculo só grava revisão quando o hash, o status ou o valor mudam, e confirma o snapshot quando
 * nada mudou (finance.snapshots.js, DI-BI-2). Algumas entradas da fórmula dizem só QUANDO o cálculo foi feito: a idade da última medição das filas (tec.queues_dlq) e o
 * instante da leitura das filas de decisão (M9-D709). Elas mudam a cada passada; no hash, o número gravava uma revisão nova a cada recálculo sem que nada do snapshot
 * tivesse mudado (566 revisões de tec.queues_dlq num dia na homologação, alternando uma sem confirmação e outra confirmada).
 * Por isso, no hash, a entrada volátil sai e entra no lugar o efeito dela no resultado (status, valor e dimensões): o hash continua mudando quando a idade torna a
 * fila STALE ou quando um item da fila de decisão passa do limite de horas, e não muda quando só o relógio andou.
 */
function hashInputsOf(inputs, volatileKeys, result) {
  if (!Array.isArray(volatileKeys) || !volatileKeys.length || !inputs || typeof inputs !== 'object') return inputs;
  const kept = Object.fromEntries(Object.entries(inputs).filter(([key]) => !volatileKeys.includes(key)));
  return { ...kept, readingEffect: { status: result.status, value: result.value === undefined ? null : result.value, dimensions: result.dimensions || [] } };
}

module.exports = { hashInputsOf };
