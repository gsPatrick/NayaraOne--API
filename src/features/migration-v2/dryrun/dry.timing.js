'use strict';

/** Mede e registra uma fase do ensaio: nome, estado (DONE ou FAILED), duração e o detalhe (ou o erro { code, message }). A falha da fase não derruba o ensaio: os critérios a refletem. */
async function timedPhase(phases, name, fn) {
  const startedAt = new Date();
  const entry = { name, status: 'DONE', startedAt: startedAt.toISOString(), durationMs: 0, detail: null, error: null };
  try {
    entry.detail = await fn();
  } catch (err) {
    entry.status = 'FAILED';
    entry.error = { code: err.code || 'ERROR', message: String(err.message || err).slice(0, 300) };
  }
  entry.durationMs = Date.now() - startedAt.getTime();
  phases.push(entry);
  return entry;
}

module.exports = { timedPhase };
