'use strict';

const E = require('./memory.errors');

const DAY_MS = 24 * 3600 * 1000;

/**
 * Validade da memória (regra 2). Sem `expiresAt` o padrão vem do parâmetro: `ia.memoria.validade_dias` (SESSION:
 * `ia.memoria.validade_sessao_dias`); com conversa inteira, `ia.memoria.transcript_validade_horas`. `expiresAt: null` é recusado.
 * São dias corridos (America/Sao_Paulo não tem horário de verão). Devolve { validFrom, expiresAt }.
 */
function resolveValidity(input, params, now = new Date()) {
  let validFrom = now;
  if (input.validFrom !== undefined && input.validFrom !== null) {
    validFrom = new Date(input.validFrom);
    if (Number.isNaN(validFrom.getTime())) throw E.expiresInvalid('A data de início da validade é inválida.');
  }
  let expiresAt;
  if (input.expiresAt === undefined) {
    const days = input.scope === 'SESSION' ? params.sessionDays : params.validityDays;
    expiresAt = new Date(now.getTime() + days * DAY_MS);
    if (input.hasTranscript) expiresAt = new Date(Math.min(expiresAt.getTime(), now.getTime() + params.transcriptHours * 3600 * 1000));
  } else {
    expiresAt = input.expiresAt === null ? new Date(NaN) : new Date(input.expiresAt);
    if (Number.isNaN(expiresAt.getTime())) throw E.expiresInvalid('Informe a data de expiração da memória.');
  }
  if (expiresAt.getTime() <= now.getTime()) throw E.expiresInvalid('A expiração precisa ser uma data futura.');
  if (expiresAt.getTime() <= validFrom.getTime()) throw E.expiresInvalid('A expiração precisa ser depois do início da validade.');
  return { validFrom, expiresAt };
}

module.exports = { resolveValidity, DAY_MS };
