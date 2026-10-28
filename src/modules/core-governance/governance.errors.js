'use strict';

const AppError = require('../../utils/AppError');

/**
 * Erros do bloco de governança (M9-D800, decisões K4 e K5).
 *
 * K4: todo código NOVO criado pelo bloco tem prefixo GOV_. A lista fechada abaixo reúne os códigos que já existem na
 * plataforma e são reaproveitados sem renomear (não quebram os demais módulos nem os clientes atuais). É também o padrão
 * do parâmetro `governanca.erros.excecoes_prefixo_gov`. O catálogo de erros do CI (M9-D843) varre só core-governance.
 *
 * K5: corpo de erro ÚNICO `{success:false,error:{code,message,details?,traceId}}`, com traceId DENTRO de `error` (igual ao
 * correlationId da requisição e ao cabeçalho X-Correlation-Id). O envelope é aplicado por `errorEnvelope`, montado nos
 * prefixos do bloco, e cobre também os erros da plataforma (401 de token ausente, 403 de permissão) nessas rotas.
 */
const DEFAULT_PREFIX_EXCEPTIONS = Object.freeze([
  'PERMISSION_DENIED',
  'MISSING_ACCESS_TOKEN',
  'MFA_STEP_UP_REQUIRED',
  'MFA_REQUIRED_NOT_ENABLED',
  'INTERNAL_ERROR',
  'VALIDATION_ERROR',
]);

const GOV_PREFIX = 'GOV_';

function isAllowedCode(code, exceptions = DEFAULT_PREFIX_EXCEPTIONS) {
  return typeof code === 'string' && (code.startsWith(GOV_PREFIX) || exceptions.includes(code));
}

/** Cria um AppError de governança; recusa código sem prefixo GOV_ que não esteja na lista fechada. */
function govError(statusCode, code, message, details) {
  if (!isAllowedCode(code)) {
    throw new Error(`Código de erro "${code}" fora do padrão: todo código novo do bloco de governança leva o prefixo ${GOV_PREFIX}.`);
  }
  return new AppError(message, statusCode, code, details);
}

function govNotFound(message = 'Registro não encontrado.', details) {
  return govError(404, 'GOV_NOT_FOUND', message, details);
}

function govModuleDisabled(moduleCode) {
  return govError(403, 'GOV_MODULE_DISABLED', 'Este módulo de governança está desativado pelo administrador.', { module: moduleCode });
}

/** Lê a lista de exceções configurada (texto separado por vírgula); vazio/ inválido volta ao padrão da lista fechada. */
function parseExceptions(text) {
  if (typeof text !== 'string') return [...DEFAULT_PREFIX_EXCEPTIONS];
  const list = text.split(',').map((item) => item.trim()).filter(Boolean);
  return list.length ? list : [...DEFAULT_PREFIX_EXCEPTIONS];
}

/**
 * Middleware: garante `error.traceId` (= correlationId) em toda resposta de erro das rotas de governança, venha o erro do
 * bloco ou da plataforma. Nunca devolve traceId na raiz.
 */
function errorEnvelope(req, res, next) {
  const originalJson = res.json.bind(res);
  res.json = function jsonWithTrace(body) {
    if (body && body.success === false && body.error && typeof body.error === 'object') {
      const { traceId: _ignored, ...rest } = body.error;
      const { traceId: _root, ...root } = body;
      return originalJson({ ...root, error: { ...rest, traceId: req.correlationId || res.getHeader('X-Correlation-Id') || null } });
    }
    return originalJson(body);
  };
  next();
}

module.exports = { DEFAULT_PREFIX_EXCEPTIONS, GOV_PREFIX, isAllowedCode, govError, govNotFound, govModuleDisabled, parseExceptions, errorEnvelope };
