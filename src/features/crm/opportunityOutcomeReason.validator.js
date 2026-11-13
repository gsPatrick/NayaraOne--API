'use strict';

const AppError = require('../../utils/AppError');
const { readOutcomeReasonCatalog } = require('./crm.params');
const { parseReasonList, DEFAULT_WON_REASONS, DEFAULT_LOST_REASONS, DEFAULT_WITHDRAWAL_REASONS } = require('./crm.settings');

/**
 * M3-12 / CRMX-013 — motivos ESTRUTURADOS de ganho, perda e desistência (livro §3 crm.loss_reasons; Guia §8 "LOST sem reason
 * não fecha"). As listas são parâmetros da empresa (crm.motivos.ganho / .perda / .desistencia, DI-M3CA-2), com os padrões abaixo.
 * Desistência é LOST com motivo da categoria desistência (o livro §10 não tem estágio próprio; DI-M3CA-3): o código vai para
 * lost_reason e também para withdrawn_reason, que marca a categoria do desfecho.
 *
 * Regra do motivo (CRMX-005 e CRM-TS-008): ao ENTRAR num estágio de desfecho, o motivo precisa vir no pedido; o motivo de um
 * desfecho anterior (a oportunidade foi reaberta) nunca fecha a oportunidade de novo sozinho. Reeditar uma oportunidade que já
 * está no desfecho, sem mexer no motivo, mantém o motivo gravado.
 */

const codesOf = (text) => parseReasonList(text).map((r) => r.code);
const WON_REASONS = Object.freeze(codesOf(DEFAULT_WON_REASONS));
const LOST_REASONS = Object.freeze(codesOf(DEFAULT_LOST_REASONS));
const WITHDRAWN_REASONS = Object.freeze(codesOf(DEFAULT_WITHDRAWAL_REASONS));
const OUTCOME_STAGES = Object.freeze(['WON', 'LOST']);

const normalize = (value) => (value === undefined || value === null ? null : String(value).trim().toUpperCase() || null);

function refuse(code, message, details) {
  throw AppError.unprocessable(message, code, details);
}

/**
 * resolveOutcomeReason — devolve null (estágio não é desfecho) ou { stage, wonReason, lostReason, withdrawnReason } com os
 * valores a gravar. `entering` = o pedido está levando a oportunidade para este desfecho agora. `current` = valores gravados.
 * `withdrawal` = a entrada pediu WITHDRAWN (o motivo tem de ser de desistência).
 */
async function resolveOutcomeReason({ stage, entering, withdrawal = false, input = {}, current = {} }, tenant, transaction) {
  if (!OUTCOME_STAGES.includes(stage)) return null;
  const catalog = await readOutcomeReasonCatalog(tenant, transaction);

  if (stage === 'WON') {
    const value = normalize(input.wonReason) || (entering ? null : normalize(current.wonReason));
    const allowed = catalog.won.map((r) => r.code);
    if (!value) refuse('OPPORTUNITY_OUTCOME_REASON_REQUIRED', `Fechar como ganha (WON) exige o motivo de ganho em "wonReason" (um de: ${allowed.join(', ')}).`, { stage, field: 'wonReason', allowed });
    if (!allowed.includes(value)) refuse('OPPORTUNITY_OUTCOME_REASON_INVALID', `O motivo "${value}" não é um motivo de ganho desta empresa. Use um de: ${allowed.join(', ')}.`, { stage, field: 'wonReason', allowed, received: value });
    return { stage, wonReason: value };
  }

  const requested = normalize(input.lostReason) || normalize(input.withdrawnReason);
  const value = requested || (entering ? null : normalize(current.lostReason));
  const lossCodes = catalog.lost.map((r) => r.code);
  const withdrawalCodes = catalog.withdrawal.map((r) => r.code);
  const allowed = withdrawal ? withdrawalCodes : [...lossCodes, ...withdrawalCodes];
  if (!value) refuse('OPPORTUNITY_OUTCOME_REASON_REQUIRED', `Marcar como perdida (LOST) exige o motivo em "lostReason" (um de: ${allowed.join(', ')}).`, { stage, field: 'lostReason', allowed });
  if (!allowed.includes(value)) {
    const what = withdrawal ? 'de desistência' : 'de perda ou de desistência';
    refuse('OPPORTUNITY_OUTCOME_REASON_INVALID', `O motivo "${value}" não é um motivo ${what} desta empresa. Use um de: ${allowed.join(', ')}.`, { stage, field: 'lostReason', allowed, received: value });
  }
  const isWithdrawal = !lossCodes.includes(value) && withdrawalCodes.includes(value);
  const keepCategory = !requested && current.withdrawnReason; // reedição sem motivo novo: a categoria gravada continua
  return { stage, lostReason: value, withdrawnReason: isWithdrawal ? value : keepCategory ? current.withdrawnReason : null };
}

module.exports = { WON_REASONS, LOST_REASONS, WITHDRAWN_REASONS, OUTCOME_STAGES, resolveOutcomeReason };
