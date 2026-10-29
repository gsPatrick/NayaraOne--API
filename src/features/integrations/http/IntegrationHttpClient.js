'use strict';

const { resilientFetch } = require('../../../utils/resilientFetch');
const { httpsRequestJson, createMtlsAgent } = require('./httpsTransport');

/**
 * IntegrationHttpClient — o ÚNICO ponto por onde um adapter fala HTTP com o fornecedor (M9-D209 3.4 item 1). Generaliza
 * utils/resilientFetch.js: tempo máximo por tipo de chamada (leitura/escrita, parâmetros da empresa), circuit breaker por
 * chave de fornecedor e transporte HTTPS com certificado de cliente (mTLS). Os demais controles do livro entram AQUI, sem
 * mexer em nenhum adapter: SSRF e allowlist de saída (M9-D244/D245), redação (D246), métricas (D224), breaker
 * configurável (D217). Um adapter que use fetch/axios/https direto reprova no teste de arquitetura.
 */
const DEFAULT_TIMEOUT_MS = 20000;

class IntegrationHttpClient {
  /** `opts`: providerCode, connectionId, timeouts { readMs, writeMs }. */
  constructor(opts = {}) {
    this.providerCode = opts.providerCode || 'desconhecido';
    this.connectionId = opts.connectionId || null;
    this.timeouts = { readMs: opts.timeouts?.readMs || DEFAULT_TIMEOUT_MS, writeMs: opts.timeouts?.writeMs || DEFAULT_TIMEOUT_MS };
  }

  circuitKey(extra) {
    return `integration:${this.providerCode}:${this.connectionId || 'global'}${extra ? `:${extra}` : ''}`;
  }

  timeoutFor(method) {
    return ['GET', 'HEAD'].includes(String(method || 'GET').toUpperCase()) ? this.timeouts.readMs : this.timeouts.writeMs;
  }

  /** Chamada com timeout, tentativas só para erro transitório e circuit breaker (resilientFetch). */
  request({ method = 'GET', url, headers, body, timeoutMs, maxAttempts, circuitKey }) {
    return resilientFetch({ circuitKey: circuitKey || this.circuitKey(), url, method, headers, body, timeoutMs: timeoutMs || this.timeoutFor(method), maxAttempts });
  }

  /** Passagem direta ao fetch global (o mesmo contrato dele), com tempo máximo quando o chamador não trouxe um sinal. */
  fetch(url, init = {}) {
    const comSinal = init.signal ? init : { ...init, signal: AbortSignal.timeout(this.timeoutFor(init.method)) };
    return fetch(url, comSinal);
  }

  /** HTTPS com certificado de cliente (mTLS): devolve { statusCode, body } com o corpo já lido como JSON. */
  httpsJson({ method, url, headers, body, agent }) {
    return httpsRequestJson({ method, url, headers, body, agent });
  }
}

module.exports = { IntegrationHttpClient, DEFAULT_TIMEOUT_MS, createMtlsAgent };
