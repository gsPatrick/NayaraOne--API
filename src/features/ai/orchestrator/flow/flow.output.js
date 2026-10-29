'use strict';

const Ajv = require('ajv');

const ajv = new Ajv({ allErrors: false, coerceTypes: false, removeAdditional: false, strictKeywords: true });

function tryParse(text) {
  try { return JSON.parse(text); } catch (e) { return null; }
}

/** Nota de 0 a 1 que o próprio modelo informa no JSON (sinal para o escalonamento do roteador, nunca para liberar ação). */
function modelScoreOf(parsed) {
  if (!parsed || typeof parsed !== 'object') return undefined;
  const informed = Object.prototype.hasOwnProperty.call(parsed, 'confidence');
  const score = Number(parsed.confidence);
  return informed && Number.isFinite(score) && score >= 0 && score <= 1 ? score : undefined;
}

/** Número do texto/valor, ou `undefined` quando não há valor. */
const numberOrUndefined = (value) => (value === null || value === undefined ? undefined : Number(value));

/**
 * A saída do modelo contra o contrato do agente: se `modelPolicy.outputSchema` existe, o texto precisa ser um JSON que o obedeça;
 * `confidence` (número de 0 a 1) é lida do JSON quando o modelo a informa. Sem schema no agente a saída é texto livre e vale.
 * Retorna `{ schemaValid, confidence, parsed }`.
 */
function evaluateOutput(agent, text) {
  const schema = agent && agent.modelPolicy && agent.modelPolicy.outputSchema;
  const parsed = tryParse(text);
  let schemaValid = true;
  if (schema) {
    try {
      schemaValid = parsed !== null && typeof parsed === 'object' && ajv.validate(schema, parsed) === true;
    } catch (e) {
      schemaValid = false;
    }
  }
  return { schemaValid, confidence: modelScoreOf(parsed), parsed };
}

/** O texto que vai à validação de grounding: se o agente devolve JSON, a resposta ao usuário é o campo `answer` (ou o texto inteiro). */
function answerTextOf(agent, text, parsed) {
  const schema = agent && agent.modelPolicy && agent.modelPolicy.outputSchema;
  return schema && parsed && typeof parsed.answer === 'string' ? parsed.answer : text;
}

module.exports = { evaluateOutput, answerTextOf, numberOrUndefined };
