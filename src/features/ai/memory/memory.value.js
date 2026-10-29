'use strict';

const { assertMemoryValue, loadMemoryPolicy } = require('../guards/naoImprovisar');
const { redactForStorage } = require('../security/piiRedactor');
const E = require('./memory.errors');
const { TRANSCRIPT_TYPES } = require('./memory.constants');
const { validateValue } = require('./memory.schema');
const { applyPiiPolicy } = require('./memory.pii');

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Texto maior que o limite em qualquer folha (fora do `transcript`) é conversa, não fato: 422. */
function hasLongText(valor, max, profundidade = 0) {
  if (profundidade > 6) return true;
  if (typeof valor === 'string') return valor.length > max;
  if (Array.isArray(valor)) return valor.some((i) => hasLongText(i, max, profundidade + 1));
  if (isObject(valor)) return Object.values(valor).some((i) => hasLongText(i, max, profundidade + 1));
  return false;
}

/**
 * Conversa inteira (`transcript`): só com `ia.memoria.guardar_conversa_inteira` Ligado E as quatro condições da M9-D009: (0) tipo
 * DECISION ou RECOMMENDATION_OUTCOME, (a) ator com ai:admin, (b) escopo SESSION, (c) validade até `transcript_validade_horas`,
 * (d) texto redigido, até `transcript_max_caracteres` e classificação diferente de RESTRICTED. Fora disso: 422.
 */
function checkTranscript(value, input, params, now) {
  const { type, scope, classification, expiresAt, isAdmin } = input;
  const horas = params.transcriptHours * 3600 * 1000;
  const ok = TRANSCRIPT_TYPES.includes(type) && isAdmin && scope === 'SESSION' && classification !== 'RESTRICTED'
    && typeof value.transcript === 'string' && value.transcript.length > 0 && value.transcript.length <= params.transcriptMax
    && expiresAt.getTime() <= now.getTime() + horas;
  if (!ok) throw E.freeText();
}

/**
 * Prepara o `value` para gravar: (1) só objeto estruturado, sem conversa (guarda única da M9-D002); (2) texto longo é recusado;
 * (3) conversa inteira só sob a regra única; (4) dado pessoal pela política da regra 3; (5) schema do tipo.
 * Devolve { value, piiRemoved, piiFound }.
 */
async function prepareValue(ctx, input, params, transaction, now = new Date()) {
  const policy = await loadMemoryPolicy(ctx, transaction);
  const verdict = assertMemoryValue(input.value, policy); // 422 AI_MEMORY_FREE_TEXT_BLOCKED se não for objeto ou tiver conversa com o parâmetro Desligado
  const { transcript, ...rest } = input.value;
  if (hasLongText(rest, params.valueMax)) throw E.freeText();
  let kept = rest;
  if (verdict.regraUnicaD009 || transcript !== undefined) {
    if (!verdict.regraUnicaD009) throw E.freeText();
    checkTranscript(input.value, input, params, now);
  }
  const permit = Boolean(input.purpose) && params.piiTypes.has(input.type);
  const pii = applyPiiPolicy(input.type, kept, { permit });
  kept = pii.value;
  const allowTranscript = transcript !== undefined;
  const value = validateValue(input.type, allowTranscript ? { ...kept, transcript: redactForStorage(transcript) } : kept, { allowTranscript });
  return { value, piiRemoved: pii.removed, piiFound: pii.found };
}

module.exports = { prepareValue };
