'use strict';

/**
 * Falhas injetáveis dos sandboxes (M9-D229 3.2 item 5 e M9-D222 3.1): o mesmo vocabulário vale para todo adapter de laboratório.
 * O fornecedor simulado lê o tipo de falha do cabeçalho `x-sandbox-fail` do pedido (`request.headers`), do campo `request.sandboxFail`
 * ou, para os fluxos de domínio que não montam cabeçalho, de `connection.config.sandbox_fault`. Forma aceita: `429`, `fail=429`, `timeout`,
 * `invalid_number`, `auth`, `expired_token`, `malformed_json`, `missing_field`, `wrong_type`, `unknown_status` ou qualquer status HTTP 4xx/5xx.
 * O sandbox não tem rede: o "HTTP" é simulado, mas os erros saem com o mesmo formato (status, code, retryAfterMs) que o transporte real produz.
 */
const HEADER = 'x-sandbox-fail';
const WIRE_FAULTS = Object.freeze(['malformed_json', 'missing_field', 'wrong_type', 'unknown_status']);
const KNOWN = Object.freeze(['auth', 'expired_token', 'timeout', 'invalid_number', ...WIRE_FAULTS]);

const erroHttp = (status, message, extra = {}) => Object.assign(new Error(message), { status, ...extra });

/** Tipo de falha pedido (texto em minúsculas) ou null. */
function faultOf(ctx, request) {
  const headers = (request && request.headers) || {};
  const chave = Object.keys(headers).find((k) => k.toLowerCase() === HEADER);
  const bruto = (chave && headers[chave]) || (request && request.sandboxFail) || (((ctx && ctx.connection && ctx.connection.config) || {}).sandbox_fault) || null;
  if (!bruto) return null;
  const texto = String(bruto).trim().toLowerCase().replace(/^fail=/, '');
  return KNOWN.includes(texto) || /^[45]\d\d$/.test(texto) ? texto : null;
}

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/** Tempo máximo da chamada pelo contexto do adapter (leitura ou escrita); o sandbox respeita o mesmo limite que o transporte real. */
const deadlineOf = (ctx, kind) => {
  const t = (ctx && ctx.timeouts) || {};
  return (kind === 'read' ? t.readMs : t.writeMs) || 20000;
};

/** Fornecedor lento: a resposta demoraria o dobro do prazo; o cliente desiste no prazo da política (ETIMEDOUT). */
async function slowProvider(ctx, kind) {
  const prazo = deadlineOf(ctx, kind);
  const lento = sleep(prazo * 2);
  const limite = sleep(prazo).then(() => { throw Object.assign(new Error('Tempo esgotado esperando o fornecedor.'), { code: 'ETIMEDOUT', name: 'TimeoutError' }); });
  await Promise.race([lento, limite]);
}

/** Falhas que acontecem ANTES de qualquer efeito no fornecedor (HTTP, autenticação, número inválido, lentidão). Sem falha, não faz nada. */
async function raiseFault(ctx, request, kind = 'write') {
  const fault = faultOf(ctx, request);
  if (!fault || WIRE_FAULTS.includes(fault)) return fault;
  const config = (ctx && ctx.connection && ctx.connection.config) || {};
  if (fault === 'timeout') await slowProvider(ctx, kind);
  if (fault === 'auth') throw erroHttp(401, 'Credencial recusada pelo fornecedor.');
  if (fault === 'expired_token') throw erroHttp(401, 'Token expirado.', { code: 'TOKEN_EXPIRED', credentialInvalid: true });
  if (fault === 'invalid_number') throw erroHttp(422, 'Número de telefone inválido para o fornecedor.', { code: 'INVALID_NUMBER' });
  const status = Number(fault);
  if (status === 429) {
    const segundos = Number(config.sandbox_retry_after_s) > 0 ? Number(config.sandbox_retry_after_s) : 7;
    throw erroHttp(429, 'Limite de chamadas do fornecedor.', { retryAfterMs: segundos * 1000, headers: { 'retry-after': String(segundos) } });
  }
  throw erroHttp(status, `O fornecedor respondeu ${status}.`);
}

/** Resposta do fornecedor já "lida" do fio (`statusField`: nome do campo de status no vocabulário do fornecedor): aplica a falha de leitura (JSON truncado, campo faltando, tipo errado, status inédito). */
function readWire(ctx, request, resposta, statusField = 'status') {
  const fault = faultOf(ctx, request);
  if (!fault || !WIRE_FAULTS.includes(fault)) return resposta;
  // JSON truncado: o corpo não é lido; o cliente real lançaria o mesmo erro de leitura.
  if (fault === 'malformed_json') throw Object.assign(new Error('Resposta do fornecedor ilegível.'), { code: 'INTEGRATION_RESPONSE_INVALID' });
  const copia = { ...resposta };
  if (fault === 'missing_field') delete copia[statusField];
  if (fault === 'wrong_type') copia[statusField] = 12345;
  if (fault === 'unknown_status') copia[statusField] = 'STATUS_INEDITO_DO_FORNECEDOR';
  return copia;
}

module.exports = { HEADER, KNOWN, faultOf, raiseFault, readWire, erroHttp, deadlineOf, sleep };
