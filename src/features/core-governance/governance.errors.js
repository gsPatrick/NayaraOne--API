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
  'ROUTE_NOT_FOUND',
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
 * Aplica o padrão K4 a um corpo de erro já montado: código fora de GOV_ e fora da lista de exceções da empresa deixa de
 * sair como está e vira GOV_CODIGO_FORA_DO_PADRAO (mesmo status HTTP; o código original vai em details.codigoOriginal,
 * para o suporte localizar a origem). Função pura; `exceptions` vem da configuração da empresa.
 */
function enforceErrorCode(errorBody, exceptions) {
  if (!errorBody || typeof errorBody !== 'object' || isAllowedCode(errorBody.code, exceptions)) return errorBody;
  return {
    ...errorBody,
    code: 'GOV_CODIGO_FORA_DO_PADRAO',
    details: { ...(errorBody.details && typeof errorBody.details === 'object' ? errorBody.details : {}), codigoOriginal: errorBody.code },
  };
}

/**
 * Lista de exceções ao prefixo GOV_ vigente para a requisição: lê `governanca.erros.excecoes_prefixo_gov` da empresa
 * (getSetting) quando há usuário autenticado; sem contexto de empresa (ex.: 401) ou se a leitura falhar, vale o padrão do livro.
 */
async function loadExceptionsForRequest(req) {
  if (!req || !req.auth || typeof req.withTenantTransaction !== 'function') return [...DEFAULT_PREFIX_EXCEPTIONS];
  try {
    // require tardio: governance.settings e settings.service não podem ser carregados antes deste arquivo (ciclo).
    const { getSetting } = require('../../features/settings/settings.service');
    const { ERRORS_EXCEPTIONS_KEY, GOVERNANCE_SETTING_DEFAULTS } = require('./governance.settings');
    const text = await req.withTenantTransaction((transaction) => getSetting(
      ERRORS_EXCEPTIONS_KEY,
      { groupId: req.auth.groupId, companyId: req.auth.companyId },
      transaction,
      GOVERNANCE_SETTING_DEFAULTS[ERRORS_EXCEPTIONS_KEY]
    ));
    return parseExceptions(text);
  } catch (_err) {
    return [...DEFAULT_PREFIX_EXCEPTIONS];
  }
}

/**
 * Middleware: garante `error.traceId` (= correlationId) em toda resposta de erro das rotas de governança, venha o erro do
 * bloco ou da plataforma, e aplica a lista de exceções ao prefixo GOV_ configurada pelo administrador da empresa. Nunca
 * devolve traceId na raiz.
 */
function errorEnvelope(req, res, next) {
  const originalJson = res.json.bind(res);
  res.json = function jsonWithTrace(body) {
    if (body && body.success === false && body.error && typeof body.error === 'object') {
      const traceId = req.correlationId || res.getHeader('X-Correlation-Id') || null;
      const send = (exceptions) => {
        const { traceId: _ignored, ...rest } = enforceErrorCode(body.error, exceptions);
        const { traceId: _root, ...root } = body;
        return originalJson({ ...root, error: { ...rest, traceId } });
      };
      if (isAllowedCode(body.error.code, DEFAULT_PREFIX_EXCEPTIONS) && !req.auth) return send(DEFAULT_PREFIX_EXCEPTIONS);
      loadExceptionsForRequest(req).then(send, () => send(DEFAULT_PREFIX_EXCEPTIONS));
      return res;
    }
    return originalJson(body);
  };
  next();
}

module.exports = { DEFAULT_PREFIX_EXCEPTIONS, GOV_PREFIX, isAllowedCode, govError, govNotFound, govModuleDisabled, parseExceptions, enforceErrorCode, loadExceptionsForRequest, errorEnvelope };
