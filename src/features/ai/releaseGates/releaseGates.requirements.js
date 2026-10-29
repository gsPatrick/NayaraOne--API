'use strict';

const repo = require('../readmodels/releaseGateSupport.readmodel');
const agentsRepo = require('../agents/agents.repository');
const { GLOBAL_REQUIRED, FINAL_ITEM, STATUS } = require('./releaseGates.constants');
const { realProvidersInUse } = require('./releaseGates.providers');

const keyOf = (item, ref) => `${item}|${ref || ''}`;

/** Itens exigidos (livro): globais, um AGENT_EVALUATION por agente e um PROVIDER_REVIEW por provedor real; a aprovação final por último. */
function requiredItems({ agents, providers }) {
  return [
    ...GLOBAL_REQUIRED.map((item) => ({ item, ref: null })),
    ...agents.map((ref) => ({ item: 'AGENT_EVALUATION', ref })),
    ...providers.map((ref) => ({ item: 'PROVIDER_REVIEW', ref })),
  ];
}

const labelOf = ({ item, ref }) => (ref ? `${item} (${ref})` : item);

/** Quem registrou ou aprovou os itens (menos a aprovação final): a aprovação final não pode ser dessas pessoas. */
function peopleOfItems(rows) {
  const people = new Set();
  rows.filter((r) => r.item !== FINAL_ITEM).forEach((r) => { if (r.registeredBy) people.add(r.registeredBy); if (r.approvedBy) people.add(r.approvedBy); });
  return people;
}

/** Agentes da empresa que estão habilitados (versão ACTIVE) mais os `extra` que estão para ser habilitados. */
async function agentsToEnable(ctx, transaction, extra = []) {
  const active = (await agentsRepo.listActive(ctx, transaction)).map((a) => a.code);
  return [...new Set([...active, ...extra])].sort();
}

/**
 * O que falta para a NAY ir a produção nesta empresa. `includeFinal`: confere também a aprovação final e que ela é de pessoa distinta de
 * quem registrou os demais itens. Devolve { missing: [rótulo], rows, need }.
 */
async function computeMissing(ctx, transaction, { extraAgents = [], includeFinal = true } = {}) {
  const rows = await repo.list({}, transaction);
  const approved = new Map(rows.filter((r) => r.status === STATUS.APPROVED).map((r) => [keyOf(r.item, r.scopeRef), r]));
  const need = requiredItems({ agents: await agentsToEnable(ctx, transaction, extraAgents), providers: await realProvidersInUse(ctx, transaction) });
  const missing = need.filter((n) => !approved.has(keyOf(n.item, n.ref))).map(labelOf);
  if (includeFinal) {
    const final = approved.get(keyOf(FINAL_ITEM, null));
    if (!final) missing.push(FINAL_ITEM);
    else if (peopleOfItems(rows).has(final.approvedBy)) missing.push(`${FINAL_ITEM} (aprovador distinto)`);
  }
  return { missing, rows, need };
}

module.exports = { computeMissing, peopleOfItems, requiredItems };
