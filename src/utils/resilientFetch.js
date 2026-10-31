'use strict';

// GAP REAL CORRIGIDO (auditoria "mais um ciclo de 5", 2026-10-08): contrato bruto, "GUIA DO
// MARCELO — INTEGRAÇÕES, APIs E WEBHOOKS", princípios INT-005 a INT-008:
//   INT-005 — Timeout não significa falha definitiva; consultar estado antes de repetir
//             operação perigosa.
//   INT-006 — Retry depende da classe de erro; validation/auth não entram em loop.
//   INT-007 — Circuit breaker evita avalanche contra fornecedor indisponível.
//   INT-008 — Rate limits/quota são monitorados e respeitados.
// Nenhum adapter externo do projeto (InsuranceAdapter.js, BankAdapter.js, SignatureAdapter.js)
// implementava isso — primeira implementação do padrão, pensada para ser reaproveitada por
// qualquer adapter futuro. Nesta sessão, aplicado só em InsuranceAdapter.js (Seguros é Marco 7);
// BankAdapter.js/SignatureAdapter.js têm a mesma lacuna mas pertencem a outros módulos, fora do
// escopo desta auditoria.
//
// Contrato não especifica números de timeout/retry — valores abaixo são decisão de engenharia documentada:
// timeout 20s (padrão de mercado para API B2B de seguradora, entre o "rápido" de leitura
// simples e o limite de 30s de gateway/load balancer); 3 tentativas totais com backoff
// exponencial + jitter, só para TIMEOUT/erro de rede/429/5xx (nunca para 4xx de
// validação/autenticação — exatamente a proibição de INT-006).
//
// Circuit breaker (INT-007): desde a M9-D217 este arquivo NÃO tem mais limiar, cooldown nem estado de circuito próprios. Ele delega
// à máquina de estados única (src/features/integrations/health/circuitGate.js) cuja política (falhas seguidas, cooldown, chamadas de
// teste em HALF_OPEN) vem de health/circuitPolicy.js. Quem chama com connection (adapters via IntegrationHttpClient) passa
// `circuitManaged: true`: o circuito dessas é o persistido por connection, decidido pelo Dispatch Service, e aqui nada é contado.

const { admit, record } = require('../features/integrations/health/circuitGate');

const DEFAULT_TIMEOUT_MS = 20000;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BASE_DELAY_MS = 500;

const RETRYABLE_STATUS_CODES = new Set([429, 502, 503, 504]);

/** Classe de erro de uma resposta final: só 5xx (e rede/timeout, tratados no catch) conta como falha do fornecedor. */
function classOfStatus(status) {
  if (status === 429) return 'RATE_LIMIT';
  if (status === 401 || status === 403) return 'AUTH';
  if (status >= 500) return 'TRANSIENT';
  return 'VALIDATION';
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
/** Erros em que a requisição nem chegou ao fornecedor: seguro repetir mesmo uma operação que altera estado. */
const NOT_SENT_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN']);

/**
 * INT-005 (M9-D216, reabertura M2): uma operação que altera estado (POST, PUT, PATCH, DELETE) só é repetida às cegas se for idempotente:
 * a chamada traz cabeçalho `Idempotency-Key` (a mesma chave vai em todas as tentativas) ou o chamador declara `idempotent: true`.
 * Sem isso, só 429 (o fornecedor recusou sem processar) e falha de conexão antes do envio são repetidas; timeout, reset e 502/503/504
 * podem ter sido processados e ficam para a consulta de reconciliação (UNKNOWN, M9-D215), nunca para um segundo envio.
 */
function repeatsBlindly({ method, headers, idempotent }) {
  if (idempotent === true || SAFE_METHODS.has(String(method || 'GET').toUpperCase())) return true;
  return Object.keys(headers || {}).some((h) => h.toLowerCase() === 'idempotency-key');
}

/** O fetch do Node embrulha a falha de rede em `TypeError: fetch failed`; o código (ECONNREFUSED, ENOTFOUND...) vem em `cause`. */
const codeOf = (err) => (err && (err.code || (err.cause && err.cause.code))) || null;

function isRetryableError(err) {
  if (err && err.code === 'TIMEOUT') return true;
  if (['ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN'].includes(codeOf(err))) return true;
  if (err && err.name === 'AbortError') return true;
  return false;
}

/**
 * resilientFetch — chamada HTTP com timeout real (AbortController), retry classificado por
 * erro/status (nunca em 4xx de validação/auth — INT-006) e circuit breaker por provider
 * (INT-007). Operação que altera estado sem chave de idempotência não é repetida às cegas (INT-005). Uso: await resilientFetch({ circuitKey: 'insurance:portoseguro', url, method,
 * headers, body, timeoutMs, maxAttempts }).
 */
async function resilientFetch({ circuitKey, url, method = 'GET', headers, body, timeoutMs = DEFAULT_TIMEOUT_MS, maxAttempts = DEFAULT_MAX_ATTEMPTS, circuitManaged = false, idempotent = false, fetchImpl = fetch }) {
  const cego = repeatsBlindly({ method, headers, idempotent });
  const gate = circuitManaged ? null : admit(circuitKey);
  const registrar = (outcome) => { if (gate) record(circuitKey, { ...outcome, probe: gate.probe }); };

  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, { method, headers, body, signal: controller.signal });
      if (response.status >= 200 && response.status < 300) {
        registrar({ ok: true });
        return response;
      }
      if (RETRYABLE_STATUS_CODES.has(response.status) && (cego || response.status === 429) && attempt < maxAttempts) {
        const retryAfterHeader = response.headers.get('retry-after');
        const retryAfterMs = retryAfterHeader ? Number(retryAfterHeader) * 1000 : null;
        await sleep(retryAfterMs || DEFAULT_BASE_DELAY_MS * 2 ** (attempt - 1) + Math.floor(Math.random() * 250));
        continue;
      }
      // Resposta de erro final (4xx sem retry por INT-006, ou 5xx/429 com tentativas esgotadas):
      // devolve a resposta pro chamador decidir a mensagem de negócio (ex. AppError.internal com
      // o body), mas conta como falha pro circuit breaker — um provider que só devolve 5xx não
      // pode "passar" no circuito só porque não lançou exceção.
      registrar({ ok: false, errorClass: classOfStatus(response.status) });
      return response;
    } catch (err) {
      if (err.name === 'AbortError') {
        lastError = Object.assign(new Error(`Timeout de ${timeoutMs}ms excedido (INT-005) chamando "${url}".`), { code: 'TIMEOUT' });
      } else {
        lastError = err;
      }
      if (isRetryableError(lastError) && (cego || NOT_SENT_CODES.has(codeOf(lastError))) && attempt < maxAttempts) {
        await sleep(DEFAULT_BASE_DELAY_MS * 2 ** (attempt - 1) + Math.floor(Math.random() * 250));
        continue;
      }
      break;
    } finally {
      clearTimeout(timer);
    }
  }

  registrar({ ok: false, errorClass: 'TRANSIENT' });
  throw lastError;
}

module.exports = { resilientFetch, isRetryableError };
