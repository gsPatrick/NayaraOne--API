'use strict';

const { validateAgainstFacts } = require('./pipeline.factualPort');

/** M9-D406 função 3 — validação factual do texto da versão corrente contra os fatos gravados na própria versão. */
async function factualStep({ version }) {
  const text = version.body_json && typeof version.body_json.texto === 'string' ? version.body_json.texto : '';
  const result = validateAgainstFacts(text, version.facts_snapshot_json || {});
  const findings = Array.isArray(result.findings) ? result.findings : [];
  return {
    ok: Boolean(result.ok) && findings.length === 0,
    to: result.ok && findings.length === 0 ? 'FACT_CHECKED' : 'FACT_CHECK_FAILED',
    detalhes: { findings },
  };
}

module.exports = { factualStep };
