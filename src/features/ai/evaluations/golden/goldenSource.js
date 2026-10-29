'use strict';

const { registerCaseSource } = require('../cases/caseSources');
const { toCaseDef } = require('./goldenMapper');
const repo = require('./golden.repository');

/**
 * Golden datasets entram na avaliação pela porta `registerCaseSource` (M9-D032). A fonte é síncrona; o banco é lido uma vez por
 * avaliação, antes (`attachGoldenCases`), e guardado no próprio objeto do agente da execução: sem estado global entre empresas.
 */
async function attachGoldenCases(ctx, agent, transaction) {
  agent.goldenCases = await repo.activeFor(ctx, agent.code, transaction);
  return agent.goldenCases;
}

const goldenCaseSource = (agent) => (agent && Array.isArray(agent.goldenCases) ? agent.goldenCases.map(toCaseDef) : []);

let unregister = null;
function registerGoldenSource() {
  if (!unregister) unregister = registerCaseSource(goldenCaseSource);
  return unregister;
}

module.exports = { attachGoldenCases, goldenCaseSource, registerGoldenSource };
