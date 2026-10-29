'use strict';

const E = require('./recommendation.errors');

/**
 * Porta do snapshot (M9-D019): quem confere se a situação mudou desde a proposta registra aqui uma função
 * `(recommendation, ctx, transaction) => hashAtual`. Sem verificador registrado nada é conferido (não há como saber).
 * Hash diferente do `proposed_action.snapshot_hash` torna a recomendação STALE no aceite.
 */
let checker = null;

function registerSnapshotChecker(fn) {
  if (fn !== null && typeof fn !== 'function') throw new TypeError('O verificador de snapshot deve ser uma função.');
  checker = fn;
}
const getSnapshotChecker = () => checker;

/** Erro 409 AI_PROPOSAL_STALE para a camada HTTP responder depois de gravar o STALE (a rota é da M9-D031/D019). */
const staleError = () => E.stale();

module.exports = { registerSnapshotChecker, getSnapshotChecker, staleError };
