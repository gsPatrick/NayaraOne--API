'use strict';

// M9-D021 — filtro da entrada do PRÓPRIO usuário: tentativa de override ou de exfiltração (score no bloqueio) é recusada com
// 422 AI_INJECTION_BLOCKED antes de qualquer retrieval ou chamada de modelo. O erro não carrega o texto.

const AppError = require('../../../utils/AppError');
const { detectInjection } = require('./injectionDetector');
const { publishInjectionEvents } = require('./injectionEvents');

const MENSAGEM_BLOQUEIO = 'A solicitação foi bloqueada por conter tentativa de alterar as regras da NAY.';
const ORIGEM_ENTRADA = 'USER_INPUT';
const ID_ENTRADA = 'user-input';

/**
 * `screenUserInput(texto, { limits, ctx, runId, transaction })`: devolve a detecção (ALLOW ou SUSPICIOUS) ou lança o 422.
 * Com `ctx`, `runId` e `transaction`, o evento (SUSPICIOUS ou BLOCKED_INPUT) é publicado na transação do run.
 */
async function screenUserInput(texto, { limits, ctx, runId, transaction } = {}) {
  const det = detectInjection(texto, limits);
  const bloqueada = det.action === 'QUARANTINE';
  if (det.action !== 'ALLOW' && ctx && runId && transaction) {
    await publishInjectionEvents(ctx, runId, [{ sourceId: ID_ENTRADA, origin: ORIGEM_ENTRADA, ...det, action: bloqueada ? 'BLOCKED_INPUT' : 'SUSPICIOUS' }], transaction);
  }
  if (bloqueada) {
    throw AppError.unprocessable(MENSAGEM_BLOQUEIO, 'AI_INJECTION_BLOCKED', { detection: { action: det.action, score: det.score, patternIds: det.patternIds } });
  }
  return det;
}

module.exports = { screenUserInput, MENSAGEM_BLOQUEIO, ORIGEM_ENTRADA, ID_ENTRADA };
