'use strict';

const { callModel, makeItem, micros6 } = require('./common');

/** COST: a chamada do caso não pode custar mais que o teto do caso (`expected.maxCostMicros` do golden) ou, sem ele, o teto da empresa. */
async function evaluateCost(caseDef, env) {
  const out = await callModel(env, caseDef.input);
  const max = caseDef.golden && Number.isInteger(caseDef.golden.expected.maxCostMicros) ? caseDef.golden.expected.maxCostMicros : env.params.costMaxPerCaseMicros;
  return makeItem(caseDef, { expected: `custo até R$ ${micros6(max)}`, actual: `R$ ${micros6(out.costMicros)}`, passed: out.costMicros <= max, out, details: { costMicros: out.costMicros, maxMicros: max } });
}

/** LATENCY: a chamada do caso não pode passar do teto do caso (`expected.maxLatencyMs`) ou, sem ele, do orçamento do agente. */
async function evaluateLatency(caseDef, env) {
  const out = await callModel(env, caseDef.input);
  const max = caseDef.golden && Number.isInteger(caseDef.golden.expected.maxLatencyMs) ? caseDef.golden.expected.maxLatencyMs : env.latencyBudgetMs;
  return makeItem(caseDef, { expected: `até ${max} ms`, actual: `${out.latencyMs} ms`, passed: out.latencyMs <= max, out, details: { latencyMs: out.latencyMs, maxMs: max } });
}

module.exports = { evaluateCost, evaluateLatency };
