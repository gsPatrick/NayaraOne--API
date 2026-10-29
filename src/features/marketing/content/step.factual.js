'use strict';

const { validateAgainstFacts } = require('./pipeline.factualPort');
const { readFactualConfig } = require('./factual/settings');
const { companyDateParts } = require('./pipeline.time');

/**
 * M9-D406 função 3 / M9-D407 — validação factual do texto da versão corrente contra os fatos gravados na própria versão. A
 * tolerância de área, o dicionário de características e os telefones da empresa vêm dos parâmetros da empresa; a data do conteúdo é
 * o dia de hoje no fuso da empresa. Ok leva a FACT_CHECKED; qualquer finding, a FACT_CHECK_FAILED com os findings gravados.
 */
async function factualStep({ version, tenant, transaction, now }) {
  const text = version.body_json && typeof version.body_json.texto === 'string' ? version.body_json.texto : '';
  const config = await readFactualConfig(tenant, transaction);
  const options = { ...config, contentDate: await companyDateParts(now || new Date(), tenant, transaction) };
  const result = validateAgainstFacts(text, version.facts_snapshot_json || {}, options);
  const findings = Array.isArray(result.findings) ? result.findings : [];
  const ok = Boolean(result.ok) && findings.length === 0;
  return { ok, to: ok ? 'FACT_CHECKED' : 'FACT_CHECK_FAILED', detalhes: { findings } };
}

module.exports = { factualStep };
