'use strict';

const { finalizeGrounding } = require('../grounding');
const { enforceNumbers } = require('../numbers');
const { sanitizeOutput } = require('../outputSanitizer');
const { publishInjectionEvents } = require('../injectionEvents');
const { citationOf } = require('../citationBuilder');
const runs = require('../runs');
const E = require('./flow.errors');
const { evaluateOutput, answerTextOf, numberOrUndefined } = require('./flow.output');
const { usageFields } = require('./flow.progress');
const { applyAnswerHook } = require('./flow.serverTools');

/** As fontes do run no formato do GroundingValidator (D025): a posição na lista é o número [n] do marcador. */
const forValidator = (state) => state.sources.map((s) => ({
  sourceType: s.sourceType, sourceRef: s.sourceRef, title: s.title, version: s.sourceVersion, clause: s.clause, excerpt: s.text, values: s.values, classification: s.classification,
  effectiveFrom: s.effectiveFrom, effectiveUntil: s.effectiveUntil, retrievedAt: s.retrievedAt, relevanceScore: s.relevanceScore, usedInAnswer: s.usedInAnswer, statusAtRetrieval: s.statusAtRetrieval,
}));

/**
 * Números (D026): com números do read model no run (tool financeira ou resultado de regra), todo número do texto precisa vir deles; o que
 * não vem é regerado UMA vez e, persistindo, sobram só as frases verificadas (ou 422 AI_NUMBER_NOT_FROM_SOURCE). Sem payload, os números
 * das demais respostas são guardados pelo grounding (D025: toda afirmação com número precisa estar na fonte citada).
 */
async function checkNumbers(state, text, regenerate) {
  if (!state.numbersPayload.length) return text;
  const out = await enforceNumbers({ text, numbersPayload: state.numbersPayload, knownTexts: state.sources.map((s) => s.text), sourceCount: state.sources.length, regenerate });
  return out.text;
}

/** Aterramento (D025): fontes citadas, snapshot, insuficiência (200) ou 422 AI_UNGROUNDED_FACT; a tarefa de regra é GROUNDED pelo próprio código. */
async function groundAnswer(state, text) {
  if (state.decision.path === 'RULE') {
    const cited = forValidator(state).map((s, i) => citationOf({ ...s, sourceType: s.sourceType, excerpt: s.excerpt }, i + 1));
    const groundingStatus = state.sources.length ? 'GROUNDED' : 'NOT_APPLICABLE';
    return { answer: text, groundingStatus, sources: cited, confidence: '1.0000', snapshotAt: null, requiresHumanConfirmation: false, recommendation: null, runFields: {} };
  }
  return finalizeGrounding(state.ctx, {
    answerText: text, taskType: state.parsed.taskType, critical: false, sources: forValidator(state), snapshotAt: state.parsed.snapshotAt, runId: state.runId, agentCode: state.agent.code,
  }, state.transaction);
}

/** Defesa final da saída (D021): URL, e-mail e imagem com query que não estavam nas fontes autorizadas saem da resposta; vira evento. */
async function sanitizeAnswer(state, text) {
  const sanitized = sanitizeOutput(text, { authorizedTexts: state.sources.filter((s) => s.usedInAnswer).map((s) => s.text), userInput: state.parsed.input });
  if (sanitized.detections.length) await publishInjectionEvents(state.ctx, state.runId, sanitized.detections, state.transaction);
  return sanitized.text;
}

const unmetLine = (u) => (u.kind === 'PERMISSION' ? `Sem permissão para ${u.topic}.` : `Não foi possível consultar ${u.topic}.`);

/**
 * Passo 11: valida a saída ANTES de devolver (schema do agente, números, grounding, varredura de URL/e-mail) e só então grava, em UMA
 * transação, o estado final do run e os eventos ai.*. `regenerate(hint)` é a nova tentativa de geração (volta ao passo 6): saída fora
 * do schema -> uma nova tentativa e, persistindo, 422 AI_OUTPUT_INVALID. Insuficiência de fontes é resposta 200 (COMPLETED).
 */
async function validateAndFinish(state, text, regenerate) {
  let current = text;
  let evaluated = evaluateOutput(state.agent, current);
  if (state.decision.path !== 'RULE' && !evaluated.schemaValid) {
    current = await regenerate('A resposta anterior não obedeceu ao formato exigido. Responda de novo, no formato pedido.');
    evaluated = evaluateOutput(state.agent, current);
    if (!evaluated.schemaValid) throw E.outputInvalid();
  }
  const numbered = await checkNumbers(state, answerTextOf(state.agent, current, evaluated.parsed), (info) => regenerate(`Corrija os números: ${info.violations.map((v) => v.raw).join(', ')} não vêm das fontes. Use apenas {{num:ref}} dos valores fornecidos.`));
  const grounded = await groundAnswer(state, numbered);
  let answer = await sanitizeAnswer(state, await applyAnswerHook(state, grounded.answer));
  if (state.unmet.length && grounded.groundingStatus !== 'INSUFFICIENT_SOURCES') answer = `${answer}\n\n${state.unmet.map(unmetLine).join(' ')}`;
  if (state.notices.length) answer = `${answer}\n\n${state.notices.join(' ')}`;
  answer = state.redactor.rehydrate(answer);
  const groundingSignal = numberOrUndefined(grounded.confidence);
  const run = await runs.finishRun(state.ctx, state.runId, {
    status: 'COMPLETED', outputSummary: answer, groundingStatus: grounded.groundingStatus, confidence: groundingSignal, snapshotAt: grounded.snapshotAt || undefined, ...usageFields(state),
  }, state.transaction);
  return { run, answer, grounded };
}

module.exports = { validateAndFinish, forValidator };
