'use strict';

const AppError = require('../../utils/AppError');

/**
 * Funil do CRM pelo livro do Marco 3 §10 — catálogo FECHADO de estágios.
 * Ativos: NEW, QUALIFIED, MATCHING, VISIT_SCHEDULED, VISITED, PROPOSAL, FINANCING, CONTRACT, NURTURE.
 * Terminais: o livro chama de WON e LOST; o sistema inteiro (CRM, eventos, BI, NAY) grava CLOSED_WON e CLOSED_LOST, então
 * WON/LOST são aceitos na entrada e normalizados. WITHDRAWN é a desistência do cliente (item M3-12 do contrato:
 * "motivos estruturados de ganho, perda e desistência").
 * Estágio fora do catálogo é recusado (OPPORTUNITY_STAGE_INVALID). Linhas antigas gravadas com outro valor não são
 * reescritas: continuam legíveis e só passam a valer o catálogo quando o estágio é alterado.
 */
const ACTIVE_STAGES = Object.freeze(['NEW', 'QUALIFIED', 'MATCHING', 'VISIT_SCHEDULED', 'VISITED', 'PROPOSAL', 'FINANCING', 'CONTRACT', 'NURTURE']);
const TERMINAL_STAGES = Object.freeze(['CLOSED_WON', 'CLOSED_LOST', 'WITHDRAWN']);
const STAGES = Object.freeze([...ACTIVE_STAGES, ...TERMINAL_STAGES]);
const LIVRO_ALIASES = Object.freeze({ WON: 'CLOSED_WON', LOST: 'CLOSED_LOST' });
const DEFAULT_STAGE = 'NEW';

/** Só traduz WON/LOST e caixa; não valida (usado em filtro de listagem). */
function canonicalStage(stage) {
  const upper = String(stage === undefined || stage === null ? '' : stage).trim().toUpperCase();
  return LIVRO_ALIASES[upper] || upper;
}

/** Estágio de entrada (criação/atualização) normalizado e validado contra o catálogo do livro. */
function normalizeStage(stage) {
  const canonical = canonicalStage(stage);
  if (!STAGES.includes(canonical)) {
    throw AppError.badRequest(
      `Etapa do funil inválida${canonical ? ` ("${String(stage)}")` : ''}. Use uma destas: ${[...ACTIVE_STAGES, 'WON (ou CLOSED_WON)', 'LOST (ou CLOSED_LOST)', 'WITHDRAWN'].join(', ')}.`,
      'OPPORTUNITY_STAGE_INVALID',
      { allowed: STAGES }
    );
  }
  return canonical;
}

module.exports = { ACTIVE_STAGES, TERMINAL_STAGES, STAGES, LIVRO_ALIASES, DEFAULT_STAGE, canonicalStage, normalizeStage };
