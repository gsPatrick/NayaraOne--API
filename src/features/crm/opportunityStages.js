'use strict';

const AppError = require('../../utils/AppError');

/**
 * Funil do CRM pelo livro do Marco 3 §10 — catálogo FECHADO de estágios, gravado com os códigos do livro.
 * Ativos: NEW, QUALIFIED, MATCHING, VISIT_SCHEDULED, VISITED, PROPOSAL, FINANCING, CONTRACT, NURTURE. Terminais: WON e LOST.
 * DI-M3CA-3 (substitui a parte "grava CLOSED_WON/CLOSED_LOST" da DI-M3-FUNIL-1): o sistema grava WON e LOST; CLOSED_WON e
 * CLOSED_LOST continuam aceitos na entrada e são normalizados. A desistência (WITHDRAWN) não é estágio do livro: é LOST com motivo
 * da categoria desistência (crm.motivos.desistencia); WITHDRAWN continua aceito na entrada e vira LOST.
 * Estágio fora do catálogo é recusado (OPPORTUNITY_STAGE_INVALID). A migration 20261111031001 converteu os registros existentes.
 */
const ACTIVE_STAGES = Object.freeze(['NEW', 'QUALIFIED', 'MATCHING', 'VISIT_SCHEDULED', 'VISITED', 'PROPOSAL', 'FINANCING', 'CONTRACT', 'NURTURE']);
const TERMINAL_STAGES = Object.freeze(['WON', 'LOST']);
const STAGES = Object.freeze([...ACTIVE_STAGES, ...TERMINAL_STAGES]);
// Códigos antigos aceitos na entrada (nada quebra durante a troca de versão) e sempre gravados no código do livro.
const LEGACY_ALIASES = Object.freeze({
  CLOSED_WON: 'WON', CLOSED_LOST: 'LOST', WITHDRAWN: 'LOST',
  NOVO: 'NEW', CONTATO: 'QUALIFIED', VISITA: 'VISIT_SCHEDULED', PROPOSTA: 'PROPOSAL', GANHO: 'WON', PERDIDO: 'LOST',
  QUALIFYING: 'QUALIFIED', VISIT: 'VISIT_SCHEDULED', NEGOTIATION: 'PROPOSAL',
});
const WITHDRAWAL_ALIAS = 'WITHDRAWN';
// Leitura: o que conta como oportunidade fechada, inclusive registro gravado antes da conversão com código antigo.
const CLOSED_STAGE_CODES = Object.freeze([...TERMINAL_STAGES, 'CLOSED_WON', 'CLOSED_LOST', 'WITHDRAWN']);
const DEFAULT_STAGE = 'NEW';

const upperTrim = (stage) => String(stage === undefined || stage === null ? '' : stage).trim().toUpperCase();

/** Só traduz códigos antigos e caixa; não valida (usado em filtro de listagem). */
function canonicalStage(stage) {
  const upper = upperTrim(stage);
  return LEGACY_ALIASES[upper] || upper;
}

/** A entrada pediu desistência (WITHDRAWN): vira LOST e o motivo tem de ser da categoria desistência. */
function isWithdrawalRequest(stage) {
  return upperTrim(stage) === WITHDRAWAL_ALIAS;
}

function isTerminalStage(stage) {
  return TERMINAL_STAGES.includes(canonicalStage(stage));
}

/** Estágio de entrada (criação/atualização) normalizado e validado contra o catálogo do livro. */
function normalizeStage(stage) {
  const canonical = canonicalStage(stage);
  if (!STAGES.includes(canonical)) {
    throw AppError.badRequest(
      `Etapa do funil inválida${canonical ? ` ("${String(stage)}")` : ''}. Use uma destas: ${STAGES.join(', ')}.`,
      'OPPORTUNITY_STAGE_INVALID',
      { allowed: STAGES }
    );
  }
  return canonical;
}

module.exports = {
  ACTIVE_STAGES,
  TERMINAL_STAGES,
  STAGES,
  LEGACY_ALIASES,
  CLOSED_STAGE_CODES,
  DEFAULT_STAGE,
  canonicalStage,
  normalizeStage,
  isWithdrawalRequest,
  isTerminalStage,
};
