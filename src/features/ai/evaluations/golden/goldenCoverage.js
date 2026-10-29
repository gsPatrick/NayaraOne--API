'use strict';

const C = require('../evaluations.constants');
const repo = require('./golden.repository');
const baselineGrounding = require('../cases/baseline.grounding');
const baselineTools = require('../cases/baseline.tools');
const { goldenInsufficient } = require('../../regression/regression.errors');

const enabledToolCount = (agent) => (agent.tools || []).filter((t) => t.enabled !== false).length;

/** Categorias da suíte de ouro aplicáveis ao agente: sem ferramenta habilitada não há o que selecionar nem o que permitir. */
function applicableCategories(agent) {
  const none = enabledToolCount(agent) === 0 ? ['TOOL_SELECTION', 'PERMISSIONS'] : [];
  return C.SUITE_CATEGORIES.GOLDEN.filter((c) => !none.includes(c));
}

/**
 * Cobertura do golden do agente: ao menos um caso ACTIVE por categoria aplicável. Com `exigir_dataset_cadastrado` desligado, os
 * casos de base da engenharia (derivados da allowlist do agente) também contam, e COST e LATENCY, que a engine mede nas
 * chamadas ao modelo, ficam cobertas por qualquer caso que chame o modelo; ligado, só vale o dataset cadastrado.
 */
async function goldenCoverage(ctx, agent, { strict }, registry, transaction) {
  const registered = new Set((await repo.activeFor(ctx, agent.code, transaction)).map((c) => c.category));
  const covered = new Set(registered);
  if (!strict) {
    [...baselineGrounding.cases(), ...baselineTools.cases(agent, registry)].filter((c) => c.suite === 'GOLDEN').forEach((c) => covered.add(c.category));
    covered.add('COST');
    covered.add('LATENCY');
  }
  const required = applicableCategories(agent);
  return { required, missing: required.filter((c) => !covered.has(c)) };
}

async function assertGoldenCoverage(ctx, agent, opts, registry, transaction) {
  const { missing, required } = await goldenCoverage(ctx, agent, opts, registry, transaction);
  if (missing.length) throw goldenInsufficient({ agentCode: agent.code, faltam: missing, exigidas: required });
  return { required };
}

module.exports = { applicableCategories, goldenCoverage, assertGoldenCoverage };
