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
  'signature-': 'M9-D236', 'analytics-': 'M9-D243', 'social-': 'M9-D239',
  'ai-': 'M9-D011', anthropic: 'M9-D011', openai: 'M9-D011',
});

/**
 * Adapters registrados cujo fornecedor não tem API utilizável: o adapter só reserva o código no registro e TODA operação recusa com o erro de sempre. Não há comportamento de
 * contrato a provar (o caminho feliz não existe); o que se prova é a recusa (teste m9d238.contrato). Quando o fornecedor ganhar API, o adapter ganha fixtures e sai daqui.
 */
const WITHOUT_PUBLIC_API = Object.freeze({
  'insurance-junto-seguros': 'Junto Seguros não tem documentação técnica pública sem parceria de corretora: toda operação recusa com PROCUREMENT_INSURANCE_PROVIDER_NOT_IMPLEMENTED.',
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
    pending: registrados.filter((c) => !alvos.has(c) && !WITHOUT_PUBLIC_API[c] && pendingDemand(c)).map((c) => ({ providerCode: c, demand: pendingDemand(c) })),
    withoutApi: registrados.filter((c) => !alvos.has(c) && WITHOUT_PUBLIC_API[c]).map((c) => ({ providerCode: c, reason: WITHOUT_PUBLIC_API[c] })),
    uncovered: registrados.filter((c) => !alvos.has(c) && !pendingDemand(c) && !WITHOUT_PUBLIC_API[c]),
  };
}

module.exports = { listTargets, coverage, FIRST, PENDING_BY_DEMAND, WITHOUT_PUBLIC_API, pendingDemand };
