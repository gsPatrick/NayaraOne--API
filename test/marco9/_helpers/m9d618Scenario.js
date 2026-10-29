'use strict';

// Cenário completo da M9-D618: grava todas as fontes de uma empresa e devolve os eventos reais (nomes conferidos nos serviços) que
// atualizam cada um dos nove read models. Os testes aplicam esses eventos pelo worker do BI e conferem as linhas.
const bi = require('./biObrasJuridicoEnv');
const obras = require('./m9d618Obras');
const pos = require('./m9d618Pos');
const estoque = require('./m9d618Estoque');

const MODELS = [
  'rm_project_progress', 'rm_project_cost', 'rm_project_delays', 'rm_project_measurements', 'rm_project_nonconformities', 'rm_project_waste',
  'rm_postwork_cost', 'rm_inventory_health', 'rm_tool_assets',
];

async function seedAll(env, t) {
  const { p1, s1, s2 } = await obras.obraCompleta(env, t);
  const ledger = await obras.ledgerP1(env, t, p1);
  const contracts = await obras.contratosP1(env, t, p1);
  const p3 = await obras.obraEstourada(env, t);
  await obras.medicoes(env, t, s1);
  await obras.naoConformidades(env, t, p1);
  const stock = await estoque.estoque(env, t);
  const moves = await pos.movimentos(env, t, p1, stock.i1, stock.i2);
  const cases = await pos.garantias(env, t, p1);
  await estoque.perdas(env, t, stock.i1);
  await estoque.ferramentas(env, t);
  return { p1, p3, s1, s2, ledger, contracts, moves, cases, stock };
}

/** [tipo, payload] de um evento real por read model (e vários para o mesmo, quando o livro lista mais de um). */
function eventsOf(ids) {
  return [
    ['project.created', { id: ids.p1 }], ['project.created', { id: ids.p3 }], ['project.stage.updated', { projectId: ids.p1, stageId: ids.s1 }],
    ['measurement.approved', { projectStageId: ids.s1 }], ['finance.entry.settled', { id: ids.ledger[0] }], ['contract.activated', { id: ids.contracts.active }],
    ['project.budget.approved', { projectId: ids.p1 }], ['nonconformity.opened', { projectId: ids.p1 }], ['inventory.movement.recorded', { id: ids.moves[0] }],
    ['warranty.case.opened', { id: ids.cases.c1 }], ['warranty.case.opened', { id: ids.cases.c3 }], ['warranty.case.closed', { id: ids.cases.c2 }],
    ['inventory.stock.low', {}], ['tool.loan.created', {}],
  ];
}

/** Aplica todos os eventos do cenário à empresa. */
async function applyAll(t, ids) {
  for (const [type, payload] of eventsOf(ids)) await bi.apply(t, bi.makeEvent(t, type, payload));
}

module.exports = { MODELS, seedAll, eventsOf, applyAll };
