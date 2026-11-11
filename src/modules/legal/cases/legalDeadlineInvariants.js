'use strict';

const AppError = require('../../../utils/AppError');
const { normalizeOptionalText } = require('../shared/legalText');
const { assertCriticalDeadlineAccountability, assertHasResponsible } = require('./legalDeadlineAccountability');

const DEADLINE_CRITICALITIES = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];

/** Normaliza (caixa/espacos) e valida a criticidade; undefined quando nao informada. */
function normalizeCriticality(value) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    throw AppError.badRequest('"criticality" deve ser um texto.', 'LEGAL_DEADLINE_VALIDATION');
  }
  const criticality = normalizeOptionalText(value, 'criticality')?.toUpperCase();
  if (!criticality) return undefined;
  if (!DEADLINE_CRITICALITIES.includes(criticality)) {
    throw AppError.badRequest(`"criticality" deve ser um de: ${DEADLINE_CRITICALITIES.join(', ')}.`, 'LEGAL_DEADLINE_VALIDATION');
  }
  return criticality;
}

/**
 * Regra unica da requisicao de atualizacao: as invariantes valem sobre o estado FINAL
 * (status, responsavel, vencimento e criticidade juntos), nunca sobre o estado anterior.
 *  (a) CRITICAL com status final PENDING exige responsavel efetivo (o final do prazo ou o do
 *      processo) e destino de escalonamento no processo;
 *  (b) PENDING com vencimento final no passado exige responsavel proprio final.
 * Remover o responsavel de prazo DONE continua permitido, salvo se a mesma requisicao o reabrir.
 * So e reavaliado quando a requisicao mexe em algo que afeta a regra (responsavel, status,
 * vencimento, criticidade), para nao travar edicoes alheias de prazos legados.
 * `getLockedCase` devolve o processo ja com lock (ordem processo -> prazo).
 */
async function assertFinalDeadlineState({ final, touched, getLockedCase, now = Date.now() }) {
  if (!touched || final.status !== 'PENDING') return;
  if (!final.responsibleUserId && new Date(final.dueAt).getTime() < now) {
    throw AppError.badRequest(
      'Um prazo pendente e já vencido precisa de um responsável definido, para que alguém seja notificado de verdade.',
      'LEGAL_DEADLINE_RESPONSIBLE_REQUIRED'
    );
  }
  if (final.criticality === 'CRITICAL') {
    const legalCase = await getLockedCase();
    assertCriticalDeadlineAccountability({ responsibleUserId: final.responsibleUserId || null }, legalCase);
  }
  // (c) Caderno §15: todo prazo pendente tem responsavel (o proprio ou o do processo).
  if (!final.responsibleUserId) assertHasResponsible({ responsibleUserId: null }, await getLockedCase());
}

module.exports = { DEADLINE_CRITICALITIES, normalizeCriticality, assertFinalDeadlineState };
