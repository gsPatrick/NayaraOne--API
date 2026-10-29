'use strict';

/**
 * Tabela "Falha por passo" da M9-D020 -> estado final do run. Código de erro -> BLOCKED (e o motivo) ou FAILED. O que não está aqui
 * termina FAILED com o código do erro. O HTTP e a mensagem são os do próprio erro (cada demanda dona define os seus).
 */
const BLOCKED_REASON_BY_CODE = Object.freeze({
  AI_BUDGET_EXHAUSTED: 'BUDGET',
  AI_BUDGET_NOT_CONFIGURED: 'BUDGET',
  AI_INJECTION_BLOCKED: 'INJECTION',
  AI_CROSS_COMPANY_BLOCKED: 'CROSS_COMPANY',
  AI_SECRET_REQUEST_BLOCKED: 'SECRET',
  AI_TOOL_LIMIT_EXCEEDED: 'TOOL_LIMIT',
  AI_TOOL_NOT_ALLOWED: 'ALLOWLIST',
  AI_PERMISSION_DENIED: 'PERMISSION',
  AI_TOOL_ARGS_INVALID: 'SCHEMA',
  AI_TOOL_ARGS_FORBIDDEN_FIELD: 'SCHEMA',
  AI_CAPABILITY_FORBIDDEN: 'POLICY',
  AI_RESTRICTED_NOT_ALLOWED: 'POLICY',
});

/** Bloqueios de uma ferramenta que NÃO derrubam o run (regra única da D020): o modelo recebe "ferramenta indisponível". */
const TOOL_BLOCK_CODES = Object.freeze(['AI_TOOL_NOT_ALLOWED', 'AI_PERMISSION_DENIED', 'AI_TOOL_ARGS_INVALID', 'AI_TOOL_ARGS_FORBIDDEN_FIELD']);

const isToolBlock = (err) => Boolean(err) && TOOL_BLOCK_CODES.includes(err.code);

/** Como o run termina por causa do erro: { status, blockedReason?, errorCode }. */
function finalStateOf(err) {
  const code = (err && err.code) || 'AI_RUN_ERROR';
  const reason = BLOCKED_REASON_BY_CODE[code];
  return reason ? { status: 'BLOCKED', blockedReason: reason, errorCode: code } : { status: 'FAILED', errorCode: code };
}

/** Resposta de falha (o HTTP e o código que o cliente recebe) com o estado em que o run ficou. Nunca leva texto de entrada ou saída. */
function failureOutcome(runId, err, final, extra = {}) {
  return {
    ok: false,
    runId: runId || null,
    status: final ? final.status : null,
    blockedReason: final && final.blockedReason ? final.blockedReason : null,
    error: { status: err.statusCode || 500, code: err.code || 'AI_RUN_ERROR', message: err.message, details: err.details },
    ...extra,
  };
}

module.exports = { BLOCKED_REASON_BY_CODE, TOOL_BLOCK_CODES, isToolBlock, finalStateOf, failureOutcome };
