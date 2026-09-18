'use strict';

const AppError = require('../../utils/AppError');

/**
 * M3-12 — Motivos ESTRUTURADOS de ganho, perda e desistência.
 *
 * PROBLEMA: `Opportunity.lostReason` era TEXT livre, sem validação nenhuma. Cada corretor
 * escrevia o motivo com palavras diferentes ("caro", "achou caro", "preço"), então o painel
 * (M3-17) não conseguia agregar "motivos de perda mais comuns" de forma confiável, e ganho e
 * desistência simplesmente não tinham motivo nenhum.
 *
 * DECISÃO DE ENGENHARIA — DOCUMENTADA PORQUE NÃO ESTAVA LITERALMENTE EXPLICITADA NO CADERNO
 * CURRENT (Marco 3): a lista exata de motivos abaixo foi definida por nós. É um enum FECHADO
 * por categoria de desfecho, com um 'OTHER' em cada categoria como válvula de escape (evita
 * travar o corretor quando o motivo real não está na lista, sem reabrir o texto livre).
 *
 * Também DECIDIMOS modelar "desistência" como um novo STAGE terminal `WITHDRAWN` (e não como
 * um flag booleano à parte): `stage` já é o campo que representa o estado da oportunidade no
 * funil, então manter UMA dimensão de estado é o modelo mais simples e mantém painel e
 * listagens coerentes automaticamente. `WITHDRAWN` entra em CLOSED_STAGES
 * (opportunityNextAction.validator.js): não exige nextAction e preenche closed_at.
 *
 * A validação é de APLICAÇÃO (não CHECK constraint no banco) pelo mesmo motivo já documentado
 * em opportunityNextAction.validator.js: `stage` é string livre (funil configurável por tenant
 * no futuro), então a regra "qual motivo vale para qual desfecho" pertence à camada que
 * conhece o funil. Dados legados em `lost_reason` (texto livre gravado antes desta regra)
 * continuam legíveis — a validação só vale para gravações novas.
 */

const WON_REASONS = ['PRICE_ACCEPTED', 'FAST_DECISION', 'REFERRAL', 'OTHER'];
const LOST_REASONS = ['PRICE_TOO_HIGH', 'COMPETITOR', 'FINANCING_DENIED', 'LOCATION', 'OTHER'];
const WITHDRAWN_REASONS = ['CLIENT_GAVE_UP', 'NO_RESPONSE', 'CHANGED_MIND', 'OTHER'];

const OUTCOME_REASONS = {
  CLOSED_WON: { field: 'wonReason', allowed: WON_REASONS, label: 'ganho' },
  CLOSED_LOST: { field: 'lostReason', allowed: LOST_REASONS, label: 'perda' },
  WITHDRAWN: { field: 'withdrawnReason', allowed: WITHDRAWN_REASONS, label: 'desistência' },
};

const OUTCOME_STAGES = Object.keys(OUTCOME_REASONS);

function isOutcomeStage(stage) {
  return OUTCOME_STAGES.includes(String(stage || '').toUpperCase());
}

/**
 * assertOutcomeReason — regra dura: toda oportunidade que entra num estágio de DESFECHO
 * (CLOSED_WON / CLOSED_LOST / WITHDRAWN) precisa carregar o motivo correspondente, e esse
 * motivo precisa pertencer ao enum daquele desfecho. Lança 422 se violada.
 *
 * Retorna o motivo NORMALIZADO (upper case) quando válido, ou null quando o stage não é de
 * desfecho (nada a validar).
 */
function assertOutcomeReason({ stage, wonReason, lostReason, withdrawnReason }) {
  const normalizedStage = String(stage || '').toUpperCase();
  const spec = OUTCOME_REASONS[normalizedStage];
  if (!spec) return null;

  const rawValue = { wonReason, lostReason, withdrawnReason }[spec.field];
  const value = rawValue === undefined || rawValue === null ? null : String(rawValue).trim().toUpperCase();

  if (!value) {
    throw AppError.unprocessable(
      `Fechar uma oportunidade como "${normalizedStage}" exige o motivo de ${spec.label} em "${spec.field}" (um de: ${spec.allowed.join(', ')}).`,
      'OPPORTUNITY_OUTCOME_REASON_REQUIRED',
      { stage: normalizedStage, field: spec.field, allowed: spec.allowed }
    );
  }

  if (!spec.allowed.includes(value)) {
    throw AppError.unprocessable(
      `O motivo "${rawValue}" não é um motivo de ${spec.label} válido. Use um de: ${spec.allowed.join(', ')}.`,
      'OPPORTUNITY_OUTCOME_REASON_INVALID',
      { stage: normalizedStage, field: spec.field, allowed: spec.allowed, received: rawValue }
    );
  }

  return { field: spec.field, value };
}

module.exports = {
  WON_REASONS,
  LOST_REASONS,
  WITHDRAWN_REASONS,
  OUTCOME_REASONS,
  OUTCOME_STAGES,
  isOutcomeStage,
  assertOutcomeReason,
};
