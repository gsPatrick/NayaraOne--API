'use strict';

/**
 * M9-D609 (3.3) — registro dos provedores de snapshot. O snapshot diário calcula cada métrica com o estado do read model (nenhum read model
 * guarda histórico próprio, M9-D604), e quem sabe calcular um KPI é a demanda do KPI. Ela registra aqui um provedor:
 *   { name, metricCodes: [...], build(scope, asOfDate, transaction) -> [{ code, inputs: [entrada de recordSnapshot] }] }
 * `inputs` traz o valor principal (dimensionKey '') e as dimensões, já com metricVersionId, calcHash, status, sourceSnapshotAt e sourceRefs
 * (montado por buildSourceRefs). Sem linha do read model na data, o provedor devolve lista vazia (nada é inventado). Métrica PUBLISHED sem
 * provedor não recebe snapshot e é contada em `metrics_without_provider` no diário do job.
 */
const providers = new Map();

function registerSnapshotProvider(provider) {
  if (!provider || typeof provider.name !== 'string' || !Array.isArray(provider.metricCodes) || typeof provider.build !== 'function') {
    throw new Error('Provedor de snapshot inválido: informe name, metricCodes e build.');
  }
  providers.set(provider.name, provider);
  return () => providers.delete(provider.name);
}

const listSnapshotProviders = () => [...providers.values()];
const providerFor = (metricCode) => listSnapshotProviders().find((p) => p.metricCodes.includes(metricCode)) || null;

module.exports = { registerSnapshotProvider, listSnapshotProviders, providerFor };
