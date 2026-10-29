'use strict';

const logger = require('../../../../utils/logger');

/**
 * Trilha de spans dos 12 passos do run (M9-D020): cada passo registra `{ step, name, ms, status }` na ordem em que executou; os
 * passos 6 a 9 repetem a cada volta e o 6 volta no passo 11 numa nova tentativa. Vai no retorno do run e no log estruturado
 * (sem texto de entrada ou saída), com o `correlation_id` e o `run_id`.
 */
function createTrace({ correlationId, onSpan, clock = Date.now } = {}) {
  const spans = [];
  let runId = null;
  async function span(step, name, fn) {
    const entry = { step, name, ms: 0, status: 'ok' };
    spans.push(entry);
    const begin = clock();
    if (typeof onSpan === 'function') await onSpan({ event: 'start', step, name, runId });
    try {
      return await fn();
    } catch (err) {
      entry.status = 'error';
      entry.code = err && err.code ? err.code : 'ERROR';
      throw err;
    } finally {
      entry.ms = Math.max(0, clock() - begin);
      logger.debug({ runId, correlationId: correlationId || null, step, name, status: entry.status, ms: entry.ms }, 'ai.run.step');
      if (typeof onSpan === 'function') await onSpan({ event: 'end', ...entry, runId });
    }
  }
  /** Passo que acontece dentro de outra chamada (ex.: 8 e 9 dentro do pipeline da tool): registra o span sem duração própria. */
  function mark(step, name) {
    const entry = { step, name, ms: 0, status: 'ok' };
    spans.push(entry);
    logger.debug({ runId, correlationId: correlationId || null, step, name, status: 'ok', ms: 0 }, 'ai.run.step');
    return entry;
  }
  return { span, mark, spans, setRunId(id) { runId = id; } };
}

module.exports = { createTrace };
