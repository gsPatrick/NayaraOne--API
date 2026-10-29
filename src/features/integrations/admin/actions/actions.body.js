'use strict';

const AppError = require('../../../../utils/AppError');
const { ENVIRONMENTS } = require('../../registry/registry.constants');

/** Validação dos corpos das ações do operador (M9-D250). */
const REASON_MIN = 3;
const REASON_MAX = 500;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const invalido = (msg, campo) => AppError.unprocessable(msg, 'VALIDATION_ERROR', { campo });
const objeto = (body) => (body && typeof body === 'object' && !Array.isArray(body) ? body : {});

/** { reason, confirmDangerous }: o motivo vai à auditoria (422 INTEGRATION_RETRY_REASON_REQUIRED); confirmDangerous só aceita verdadeiro ou falso. */
function parseRetryBody(body) {
  const b = objeto(body);
  const reason = typeof b.reason === 'string' ? b.reason.trim() : '';
  if (reason.length < REASON_MIN || reason.length > REASON_MAX) {
    throw AppError.unprocessable('Informe o motivo para repetir a operação.', 'INTEGRATION_RETRY_REASON_REQUIRED', { min: REASON_MIN, max: REASON_MAX });
  }
  if (b.confirmDangerous !== undefined && typeof b.confirmDangerous !== 'boolean') throw invalido('O campo "confirmDangerous" precisa ser verdadeiro ou falso.', 'confirmDangerous');
  return { reason, confirmDangerous: b.confirmDangerous === true };
}

function parseEnvironment(valor) {
  if (!ENVIRONMENTS.includes(valor)) throw invalido(`Informe o ambiente. Use: ${ENVIRONMENTS.join(', ')}.`, 'environment');
  return valor;
}

function parseConnectionId(valor) {
  if (valor === undefined || valor === null || valor === '') return null;
  if (typeof valor !== 'string' || !UUID_RE.test(valor)) throw invalido('O identificador da integração é inválido.', 'connectionId');
  return valor.toLowerCase();
}

/** { environment, connectionId? } do teste de conexão. */
function parseTestBody(body) {
  const b = objeto(body);
  return { environment: parseEnvironment(b.environment), connectionId: parseConnectionId(b.connectionId) };
}

/** { environment, connectionId?, newSecretRef | generate, expiresAt? } da rotação: exatamente um entre a referência do novo valor e a geração pelo servidor. */
function parseRotateBody(body) {
  const b = objeto(body);
  const environment = parseEnvironment(b.environment);
  const connectionId = parseConnectionId(b.connectionId);
  const temRef = b.newSecretRef !== undefined && b.newSecretRef !== null;
  if (b.generate !== undefined && typeof b.generate !== 'boolean') throw invalido('O campo "generate" precisa ser verdadeiro ou falso.', 'generate');
  const gerar = b.generate === true;
  if (temRef === gerar) throw invalido('Informe a referência do novo valor no cofre (newSecretRef) ou peça para gerar (generate), nunca os dois nem nenhum.', 'newSecretRef');
  if (temRef && (typeof b.newSecretRef !== 'string' || !b.newSecretRef.trim())) throw invalido('A referência do novo valor no cofre é inválida.', 'newSecretRef');
  let expiresAt = null;
  if (b.expiresAt !== undefined && b.expiresAt !== null) {
    const d = new Date(b.expiresAt);
    if (typeof b.expiresAt !== 'string' || Number.isNaN(d.getTime()) || d.getTime() <= Date.now()) throw invalido('A data de vencimento da credencial precisa estar no futuro.', 'expiresAt');
    expiresAt = d;
  }
  return { environment, connectionId, newSecretRef: temRef ? b.newSecretRef.trim() : null, generate: gerar, expiresAt };
}

module.exports = { parseRetryBody, parseTestBody, parseRotateBody, REASON_MIN, REASON_MAX };
