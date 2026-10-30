'use strict';

const { violation } = require('./common');

const REGISTRO = 'src/features/integrations/registry/adapterRegistry.js';

function dependenciasPadrao() {
  require('../../../src/features/integrations/adapters').registerBuiltInAdapters();
  const registry = require('../../../src/features/integrations/registry/adapterRegistry');
  const contract = require('../../../src/features/integrations/contract');
  const { assertRunbook } = require('../../../src/features/integrations/health/runbooks');
  const { readReport } = require('../../../src/features/integrations/contract/contract.report');
  return { registry, contract, assertRunbook, readReport };
}

/**
 * Regra 7: "Não criar integração sem health/runbook/contract tests". Todo provider com adapter registrado precisa de `healthCheck`, runbook com as 7 seções e suíte de contrato verde
 * (relatório PASSED). A suíte de uma família que a M9-D222 declara pendente por demanda (a lista só encolhe) aparece em `pendentes`; adapter novo fora das duas listas reprova.
 * `deps` troca as fontes (teste sintético). Devolve as violações; `pendentes` fica na propriedade de mesmo nome do array.
 */
function scan({ deps = dependenciasPadrao() } = {}) {
  const { registry, contract, assertRunbook, readReport } = deps;
  const achados = [];
  const cobertura = contract.coverage();
  const pendentes = new Set((cobertura.pending || []).map((p) => p.providerCode));
  const semApi = new Set((cobertura.withoutApi || []).map((p) => (p && p.providerCode) || p));
  cobertura.uncovered.forEach((code) => achados.push(violation(7, REGISTRO, 1, `Provider ${code} registrado sem suíte de contrato e sem pendência declarada na M9-D222.`)));
  for (const { providerCode } of registry.list()) {
    const instancia = registry.instantiate(providerCode);
    if (!instancia || typeof instancia.healthCheck !== 'function') achados.push(violation(7, REGISTRO, 1, `Provider ${providerCode} sem healthCheck.`));
    try { assertRunbook(providerCode); } catch (err) { achados.push(violation(7, `docs/runbooks/${providerCode}.md`, 1, `Provider ${providerCode} sem runbook completo (7 seções): ${((err.details && err.details.problemas) || [err.message]).join('; ')}`)); }
    if (pendentes.has(providerCode) || semApi.has(providerCode)) continue;
    const relatorio = readReport(providerCode);
    if (!relatorio || relatorio.status !== 'PASSED') achados.push(violation(7, `reports/contract/${providerCode}.json`, 1, `Provider ${providerCode} sem relatório de contrato verde.`));
  }
  scan.pendentes = [...pendentes];
  return achados;
}

module.exports = { rule: 7, name: 'integracao_sem_health_runbook_contrato', scan };
