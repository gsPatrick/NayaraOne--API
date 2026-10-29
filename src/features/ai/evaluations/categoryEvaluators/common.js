'use strict';

const crypto = require('node:crypto');
const { redactText } = require('../../../../shared/redaction');

const SUMMARY_MAX = 300;
const sha256 = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');
const summary = (t) => redactText(String(t === undefined || t === null ? '' : t)).slice(0, SUMMARY_MAX);
const micros6 = (m) => `${Math.floor(m / 1000000)}.${String(m % 1000000).padStart(6, '0')}`;

/** Chama o modelo registrado para a avaliação e guarda custo e latência da chamada (alimentam COST e LATENCY). */
function callModel(env, input) {
  const out = env.generate({ system: env.agent.systemPolicy || '', messages: [{ role: 'user', content: input }] });
  env.calls.push({ costMicros: out.costMicros, latencyMs: out.latencyMs, modelCode: out.modelCode || null });
  return out;
}

/** Item pronto para gravar: uma unidade por caso, salvo quando o avaliador informa as suas (grounding conta afirmações). */
function makeItem(caseDef, { expected, actual, passed, score, units = 1, okUnits, out, details = {} }) {
  return {
    caseId: caseDef.id,
    category: caseDef.category,
    inputHash: sha256(caseDef.input !== undefined ? caseDef.input : JSON.stringify({ t: caseDef.toolName, p: caseDef.actorPermissions })),
    expected: summary(expected),
    actualSummary: summary(actual),
    passed,
    score: score === undefined ? (passed ? 1 : 0) : score,
    latencyMs: out ? out.latencyMs : null,
    costAmount: micros6(out ? out.costMicros : 0),
    details,
    units,
    okUnits: okUnits === undefined ? (passed ? 1 : 0) : okUnits,
  };
}

module.exports = { sha256, summary, callModel, makeItem, micros6 };
