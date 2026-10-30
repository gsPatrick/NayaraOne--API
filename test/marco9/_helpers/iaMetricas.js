'use strict';

// Apoio dos testes da observabilidade da NAY (M9-D047): leitura de uma métrica ai_* do registro Prometheus e diferença antes/depois.
const { register } = require('../../../src/utils/metrics');

/** Valor da amostra da métrica `nome` cujos rótulos incluem `labels` (soma se mais de uma casar); 0 se ainda não existe. */
async function lerMetrica(nome, labels = {}, sufixo = '') {
  const m = register.getSingleMetric(nome);
  if (!m) return 0;
  const { values } = await m.get();
  return values
    .filter((v) => (v.metricName || nome) === `${nome}${sufixo}` && Object.entries(labels).every(([k, val]) => String(v.labels[k]) === String(val)))
    .reduce((soma, v) => soma + v.value, 0);
}

/** Roda `fn` e devolve quanto a amostra mudou. */
async function variacao(nome, labels, fn, sufixo = '') {
  const antes = await lerMetrica(nome, labels, sufixo);
  await fn();
  return (await lerMetrica(nome, labels, sufixo)) - antes;
}

module.exports = { lerMetrica, variacao };
