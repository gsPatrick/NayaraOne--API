'use strict';

/** Forma da saída das operações dos adapters de modelo (M9-D010 seção 3), conferida pelos contract tests: devolve a lista de problemas (vazia = válida). */
const FINISH_REASONS = Object.freeze(['stop', 'length', 'tool_calls', 'safety']);
const SEIS_CASAS = /^\d+\.\d{6}$/;
const inteiro = (n) => Number.isInteger(n) && n >= 0;
const usageOk = (u) => Boolean(u) && inteiro(u.tokensIn) && inteiro(u.tokensOut);

const SHAPES = Object.freeze({
  generate: (r) => [
    typeof r.text !== 'string' && 'text', !Array.isArray(r.toolRequests) && 'toolRequests', !usageOk(r.usage) && 'usage', !SEIS_CASAS.test(String(r.costAmount)) && 'costAmount',
    !FINISH_REASONS.includes(r.finishReason) && 'finishReason', !(typeof r.providerRequestId === 'string' && r.providerRequestId.length > 0) && 'providerRequestId', !(Number.isFinite(r.latencyMs) && r.latencyMs >= 0) && 'latencyMs',
  ],
  embed: (r) => [
    !Array.isArray(r.vectors) && 'vectors', !(r.dimensions > 0) && 'dimensions', Array.isArray(r.vectors) && r.vectors.some((v) => !Array.isArray(v) || v.length !== r.dimensions || v.some((x) => typeof x !== 'number')) && 'vectors', !usageOk(r.usage) && 'usage',
  ],
  transcribe: (r) => [typeof r.text !== 'string' && 'text', !usageOk(r.usage) && 'usage', !SEIS_CASAS.test(String(r.costAmount)) && 'costAmount'],
  analyzeImage: (r) => [typeof r.text !== 'string' && 'text', !usageOk(r.usage) && 'usage', !SEIS_CASAS.test(String(r.costAmount)) && 'costAmount'],
});

/** Campos inválidos de `r` para a operação (lista vazia = forma correta). */
const shapeProblems = (op, r) => (r && typeof r === 'object' ? SHAPES[op](r).filter(Boolean) : ['resposta']);

/** Erro normalizado do adapter de modelo: tem `kind` e `retryable`. */
const isNormalized = (e) => Boolean(e) && typeof e.kind === 'string' && typeof e.retryable === 'boolean';

module.exports = { shapeProblems, isNormalized, FINISH_REASONS };
