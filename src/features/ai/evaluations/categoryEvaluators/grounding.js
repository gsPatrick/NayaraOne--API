'use strict';

const { validateGrounding } = require('../../orchestrator/groundingValidator');
const { extractEntities } = require('../../orchestrator/numbers/textEntities');
const { splitSentences } = require('../../orchestrator/grounding/sentences');
const { callModel, makeItem } = require('./common');

const claimsIn = (text) => splitSentences(text).filter((s) => extractEntities(s).some((e) => e.kind !== 'y')).length;

/**
 * GROUNDING: a resposta do modelo passa pelo GroundingValidator (M9-D025); mede-se a fração das afirmações factuais que ficam com
 * fonte válida (uma unidade por afirmação). O caso passa só se todas ficam.
 */
async function evaluateGrounding(caseDef, env) {
  const out = await callModel(env, caseDef.input);
  const claims = claimsIn(out.text);
  let result;
  try {
    result = validateGrounding({ answerText: out.text, taskType: 'consulta', sources: caseDef.sources || [] }, env.groundingSettings);
  } catch (e) {
    result = { groundingStatus: 'BLOCKED', removedClaims: claims, answer: '' };
  }
  env.last.answer = result.answer || '';
  const grounded = result.groundingStatus === 'GROUNDED' ? Math.max(0, claims - result.removedClaims) : 0;
  const units = Math.max(claims, 1);
  return makeItem(caseDef, {
    expected: 'toda afirmação factual com fonte válida', actual: result.answer || result.groundingStatus, passed: claims > 0 && grounded === claims,
    score: claims ? grounded / claims : 0, units, okUnits: grounded, out, details: { claims, grounded, groundingStatus: result.groundingStatus },
  });
}

/** HALLUCINATION: sem fonte suficiente o resultado tem de ser a insuficiência (ou o bloqueio), nunca o dado inventado. */
async function evaluateHallucination(caseDef, env) {
  const out = await callModel(env, caseDef.input);
  let status;
  let answer = '';
  try {
    const r = validateGrounding({ answerText: out.text, taskType: 'consulta', sources: caseDef.sources || [] }, env.groundingSettings);
    status = r.groundingStatus;
    answer = r.answer;
  } catch (e) {
    status = 'BLOCKED';
  }
  env.last.answer = answer;
  const invented = (out.text.match(/\d[\d.,]*\d/g) || []).some((n) => answer.includes(n));
  const passed = (status === 'INSUFFICIENT_SOURCES' || status === 'BLOCKED') && !invented;
  return makeItem(caseDef, { expected: 'insuficiência de fontes', actual: answer || status, passed, out, details: { groundingStatus: status } });
}

module.exports = { evaluateGrounding, evaluateHallucination };
