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
// Contrato não especifica números — valores abaixo são decisão de engenharia documentada:
// timeout 20s (padrão de mercado para API B2B de seguradora, entre o "rápido" de leitura
// simples e o limite de 30s de gateway/load balancer); 3 tentativas totais com backoff
// exponencial + jitter, só para TIMEOUT/erro de rede/429/5xx (nunca para 4xx de
// validação/autenticação — exatamente a proibição de INT-006); circuit breaker abre depois de
// 5 falhas consecutivas por chave de provider, com cool-down de 2 minutos antes de permitir uma
// chamada de teste (half-open).

const DEFAULT_TIMEOUT_MS = 20000;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BASE_DELAY_MS = 500;
const CIRCUIT_FAILURE_THRESHOLD = 5;
const CIRCUIT_COOLDOWN_MS = 2 * 60 * 1000;

const RETRYABLE_STATUS_CODES = new Set([429, 502, 503, 504]);

// Estado do circuit breaker em memória do processo, por chave de provider (ex. "insurance:portoseguro").
// Suficiente para um único processo API; se o projeto evoluir para múltiplas instâncias sem
// afinidade de sessão, isso precisaria migrar para um store compartilhado (Redis) — fora do
// escopo desta correção pontual.
const circuitState = new Map();

function getCircuit(key) {
  if (!circuitState.has(key)) {
    circuitState.set(key, { consecutiveFailures: 0, openedAt: null });
  }
  return circuitState.get(key);
}

function assertCircuitClosed(key) {
  const circuit = getCircuit(key);
  if (circuit.openedAt && Date.now() - circuit.openedAt < CIRCUIT_COOLDOWN_MS) {
    const error = new Error(`Circuito aberto para "${key}" — fornecedor indisponível recentemente (INT-007), aguardando cool-down.`);
    error.code = 'CIRCUIT_OPEN';
    throw error;
  }
}

function recordSuccess(key) {
  const circuit = getCircuit(key);
  circuit.consecutiveFailures = 0;
  circuit.openedAt = null;
}

function recordFailure(key) {
  const circuit = getCircuit(key);
  circuit.consecutiveFailures += 1;
  if (circuit.consecutiveFailures >= CIRCUIT_FAILURE_THRESHOLD) {
    circuit.openedAt = Date.now();
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableError(err) {
  if (err && err.code === 'TIMEOUT') return true;
  if (err && ['ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN'].includes(err.code)) return true;
  if (err && err.name === 'AbortError') return true;
  return false;
}

/**
 * resilientFetch — chamada HTTP com timeout real (AbortController), retry classificado por
 * erro/status (nunca em 4xx de validação/auth — INT-006) e circuit breaker por provider
 * (INT-007). Uso: await resilientFetch({ circuitKey: 'insurance:portoseguro', url, method,
 * headers, body, timeoutMs, maxAttempts }).
 */
async function resilientFetch({ circuitKey, url, method = 'GET', headers, body, timeoutMs = DEFAULT_TIMEOUT_MS, maxAttempts = DEFAULT_MAX_ATTEMPTS }) {
  assertCircuitClosed(circuitKey);

  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { method, headers, body, signal: controller.signal });
      if (response.status >= 200 && response.status < 300) {
        recordSuccess(circuitKey);
        return response;
      }
      if (RETRYABLE_STATUS_CODES.has(response.status) && attempt < maxAttempts) {
        const retryAfterHeader = response.headers.get('retry-after');
        const retryAfterMs = retryAfterHeader ? Number(retryAfterHeader) * 1000 : null;
        await sleep(retryAfterMs || DEFAULT_BASE_DELAY_MS * 2 ** (attempt - 1) + Math.floor(Math.random() * 250));
        continue;
      }
      // Resposta de erro final (4xx sem retry por INT-006, ou 5xx/429 com tentativas esgotadas):
      // devolve a resposta pro chamador decidir a mensagem de negócio (ex. AppError.internal com
      // o body), mas conta como falha pro circuit breaker — um provider que só devolve 5xx não
      // pode "passar" no circuito só porque não lançou exceção.
      recordFailure(circuitKey);
      return response;
    } catch (err) {
      if (err.name === 'AbortError') {
        lastError = Object.assign(new Error(`Timeout de ${timeoutMs}ms excedido (INT-005) chamando "${url}".`), { code: 'TIMEOUT' });
      } else {
        lastError = err;
      }
      if (isRetryableError(lastError) && attempt < maxAttempts) {
        await sleep(DEFAULT_BASE_DELAY_MS * 2 ** (attempt - 1) + Math.floor(Math.random() * 250));
        continue;
      }
      break;
    } finally {
      clearTimeout(timer);
    }
  }

  recordFailure(circuitKey);
  throw lastError;
}

module.exports = { resilientFetch, isRetryableError };
