'use strict';

/**
 * M9-D601 — apoio comum dos stores de painéis, briefings e exportações do BI (schema "analytics"):
 * tradução dos erros do Postgres para os erros de negócio do livro e validações pequenas.
 * Os códigos ANA01 a ANA06 são da D600 (metricStore); aqui ficam ANA07 a ANA10.
 */

const AppError = require('../../utils/AppError');
const { assertWriter, translateAnalyticsDbError } = require('./metricStore.service');

const MSG = {
  EXPORT_FROZEN: 'Os filtros da exportação são congelados no pedido.',
  WIDGET_FORMULA: 'Widget não pode conter fórmula ou SQL; use um indicador do registro.',
  DASHBOARD_IMMUTABLE: 'Painel publicado não pode ser alterado. Crie uma nova versão.',
  BRIEF_NO_SOURCES: 'Briefing sem fontes não pode ser gravado.',
  BRIEF_IMMUTABLE: 'Briefing gravado não pode ser alterado; gere um novo.',
};

const FORBIDDEN_KEYS = ['sql', 'formula', 'expression'];

/** Chave proibida em qualquer profundidade (mesma regra do gatilho do banco, sem diferenciar maiúscula). */
function hasForbiddenKey(value) {
  if (Array.isArray(value)) return value.some(hasForbiddenKey);
  if (value && typeof value === 'object') {
    return Object.entries(value).some(([key, inner]) => FORBIDDEN_KEYS.includes(key.toLowerCase()) || hasForbiddenKey(inner));
  }
  return false;
}

function translateDbError(err) {
  if (err instanceof AppError) return err;
  const code = err?.original?.code || err?.parent?.code || err?.code;
  const constraint = err?.original?.constraint || err?.parent?.constraint || '';
  let mapped = null;
  if (code === 'ANA07') mapped = AppError.conflict(MSG.EXPORT_FROZEN, 'ANALYTICS_EXPORT_SCOPE_FROZEN');
  else if (code === 'ANA08') mapped = AppError.unprocessable(MSG.WIDGET_FORMULA, 'ANALYTICS_WIDGET_FORMULA_FORBIDDEN');
  else if (code === 'ANA09') mapped = AppError.conflict(MSG.DASHBOARD_IMMUTABLE, 'ANALYTICS_DASHBOARD_PUBLISHED_IMMUTABLE');
  else if (code === 'ANA10') mapped = AppError.conflict(MSG.BRIEF_IMMUTABLE, 'ANALYTICS_BRIEF_IMMUTABLE');
  else if (code === '23514' && /sources_not_empty/.test(constraint)) mapped = AppError.unprocessable(MSG.BRIEF_NO_SOURCES, 'ANALYTICS_BRIEF_NO_SOURCES');
  else if (code === '23505' && /executive_briefs_current_uq/.test(constraint)) {
    mapped = AppError.conflict('Já existe briefing vigente para esta empresa, tipo e período.', 'ANALYTICS_BRIEF_ALREADY_CURRENT');
  } else if (code === '23505' && /dashboard_definitions/.test(constraint)) {
    mapped = AppError.conflict('Outra versão deste painel foi criada ou publicada agora. Recarregue e tente de novo.', 'ANALYTICS_DASHBOARD_VERSION_CONFLICT');
  } else if (code === '23505' && /dashboard_widgets_position_uq/.test(constraint)) {
    mapped = AppError.conflict('Já existe um widget nesta posição do painel.', 'ANALYTICS_WIDGET_POSITION_TAKEN');
  } else if (code === '23514') {
    mapped = AppError.badRequest('Valor fora do permitido.', 'ANALYTICS_INVALID_VALUE', { constraint });
  } else if (code === '23503' && /requested_by/.test(constraint)) {
    mapped = AppError.badRequest('Solicitante inválido.', 'ANALYTICS_EXPORT_INVALID');
  }
  if (mapped) {
    mapped.cause = err;
    return mapped;
  }
  return translateAnalyticsDbError(err);
}

async function run(fn) {
  try {
    return await fn();
  } catch (err) {
    throw translateDbError(err);
  }
}

const invalid = (code, message) => AppError.badRequest(message, code);

function requireOneOf(value, allowed, label, code) {
  if (!allowed.includes(value)) throw invalid(code, `${label} inválido. Valores aceitos: ${allowed.join(', ')}.`);
}

function requireText(value, label, code) {
  if (typeof value !== 'string' || !value.trim()) throw invalid(code, `${label} é obrigatório.`);
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Escopo da linha a partir de scopeLevel/groupId/companyId (mesma regra da D600). */
function resolveScope({ scopeLevel = 'COMPANY', groupId = null, companyId = null }, code) {
  requireOneOf(scopeLevel, ['GLOBAL', 'GROUP', 'COMPANY'], 'Escopo', code);
  if (scopeLevel === 'COMPANY' && (!companyId || !groupId)) throw invalid(code, 'Escopo de empresa exige empresa e grupo.');
  if (scopeLevel === 'GROUP' && (!groupId || companyId)) throw invalid(code, 'Escopo de grupo exige o grupo e não pode ter empresa.');
  if (scopeLevel === 'GLOBAL' && (groupId || companyId)) throw invalid(code, 'Catálogo global não tem empresa nem grupo.');
  return { companyId: scopeLevel === 'GLOBAL' ? null : companyId, groupId: scopeLevel === 'GLOBAL' ? null : groupId };
}

module.exports = { hasForbiddenKey, translateDbError, run, invalid, requireOneOf, requireText, isPlainObject, resolveScope, assertWriter, MSG };
