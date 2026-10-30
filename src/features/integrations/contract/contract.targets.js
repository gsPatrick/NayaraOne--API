'use strict';

const adapterRegistry = require('../registry/adapterRegistry');
const { listFixtureProviders } = require('./contract.fixtures');

/**
 * Quem a suíte de contrato cobre (M9-D222 3.2 item 0): o `messaging-sandbox` da M9-D229 é o PRIMEIRO adapter (passo 6 do livro) e vem antes de qualquer outro; depois entram os
 * que têm fixtures. Adapter registrado sem fixtures só pode existir na lista de PENDÊNCIAS, com a demanda do sprint dele: o teste de cobertura reprova adapter novo fora das duas listas
 * (adapter novo sem suíte verde não passa no CI, M9-D254).
 */
const FIRST = Object.freeze(['messaging-sandbox']);

/** Famílias de adapter que ainda não têm fixtures: a suíte delas entra no sprint da demanda indicada (a lista só encolhe). Casa pelo prefixo do código do fornecedor. */
const PENDING_BY_DEMAND = Object.freeze({
  'financing-': 'M9-D240', 'bank-': 'M9-D237', 'signature-': 'M9-D236', 'insurance-': 'M9-D238', 'fiscal-': 'M9-D241', 'portal-': 'M9-D232', 'analytics-': 'M9-D243', 'social-': 'M9-D239',
  'email-': 'M9-D234', 'storage-': 'M9-D242', 'identity-': 'M9-D242', 'ai-': 'M9-D011', anthropic: 'M9-D011', openai: 'M9-D011',
});
const pendingDemand = (code) => { const k = Object.keys(PENDING_BY_DEMAND).find((p) => code === p || code.startsWith(p)); return k ? PENDING_BY_DEMAND[k] : null; };

/** Alvos cobertos, na ordem de execução: primeiro o messaging-sandbox, depois os demais por código. */
function listTargets() {
  const registrados = adapterRegistry.list();
  const comFixture = new Set(listFixtureProviders());
  const alvos = registrados.filter((a) => comFixture.has(a.providerCode)).map((a) => ({ providerCode: a.providerCode, domain: a.domain, AdapterClass: adapterRegistry.instantiate(a.providerCode).constructor }));
  const ordem = (code) => { const i = FIRST.indexOf(code); return i === -1 ? FIRST.length : i; };
  return alvos.sort((a, b) => ordem(a.providerCode) - ordem(b.providerCode) || a.providerCode.localeCompare(b.providerCode));
}

/** Cobertura do registro: quem tem suíte, quem espera o sprint da demanda e quem é novo e não está em nenhuma lista (reprova). */
function coverage() {
  const registrados = adapterRegistry.list().map((a) => a.providerCode);
  const alvos = new Set(listTargets().map((t) => t.providerCode));
  return {
    covered: registrados.filter((c) => alvos.has(c)),
    pending: registrados.filter((c) => !alvos.has(c) && pendingDemand(c)).map((c) => ({ providerCode: c, demand: pendingDemand(c) })),
    uncovered: registrados.filter((c) => !alvos.has(c) && !pendingDemand(c)),
  };
}

module.exports = { listTargets, coverage, FIRST, PENDING_BY_DEMAND, pendingDemand };
