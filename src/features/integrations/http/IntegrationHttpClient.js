'use strict';

const logger = require('../../../utils/logger');
const { resilientFetch } = require('../../../utils/resilientFetch');
const { httpsRequestJson, createMtlsAgent } = require('./httpsTransport');
const { ensureMinTlsVersion } = require('./tlsPolicy');
const { assertSecureScheme, checkEgress, resolveEgressMode, hostOf, egressBlocked } = require('./egressPolicy');

/**
 * IntegrationHttpClient — o ÚNICO ponto por onde um adapter fala HTTP com o fornecedor (M9-D209 3.4 item 1). Generaliza
 * utils/resilientFetch.js: tempo máximo por tipo de chamada (leitura/escrita, parâmetros da empresa), circuit breaker por
 * chave de fornecedor e transporte HTTPS com certificado de cliente (mTLS). Em TODA chamada, antes de qualquer consulta de
 * DNS (M9-D244): só https (TLS 1.2 ou mais, certificado sempre verificado) e só host declarado pelo fornecedor
 * (`allowedHosts`); fora da lista, 502 INTEGRATION_EGRESS_BLOCKED em `enforce` ou só registro em `log`. Os demais controles
 * entram AQUI sem mexer em adapter: redação (D246), métricas (D224), breaker configurável (D217). Um adapter que use
 * fetch/axios/https direto reprova no teste de arquitetura.
 */
const DEFAULT_TIMEOUT_MS = 20000;
ensureMinTlsVersion();

class IntegrationHttpClient {
  /**
   * `opts`: providerCode, connectionId, timeouts { readMs, writeMs }, allowedHosts (hosts do fornecedor), environment
   * (SANDBOX, HOMOLOG ou PRODUCTION), egressMode ('enforce' | 'log', do parâmetro da empresa) e onEgress(evento) para
   * registrar bloqueios (o repórter da empresa grava o erro de integração). `maxAttempts` (M9-D216): tentativas internas de cada `request`;
   * o contexto dos adapters usa 1, porque quem repete é o Dispatch Service, por classe de erro e com a política da connection.
   */
  constructor(opts = {}) {
    this.providerCode = opts.providerCode || 'desconhecido';
    this.connectionId = opts.connectionId || null;
    this.timeouts = { readMs: opts.timeouts?.readMs || DEFAULT_TIMEOUT_MS, writeMs: opts.timeouts?.writeMs || DEFAULT_TIMEOUT_MS };
    this.allowedHosts = [...(opts.allowedHosts || [])];
    this.environment = opts.environment || null;
    this.egressMode = resolveEgressMode({ mode: opts.egressMode, environment: this.environment });
    this.onEgress = typeof opts.onEgress === 'function' ? opts.onEgress : null;
    this.defaultMaxAttempts = Number.isInteger(opts.maxAttempts) && opts.maxAttempts >= 1 ? opts.maxAttempts : undefined;
  }

  /** Cópia do cliente com hosts a mais (os da configuração validada do adapter, ex.: a URL base do fornecedor). */
  scoped(hosts = []) {
    return new IntegrationHttpClient({
      providerCode: this.providerCode, connectionId: this.connectionId, timeouts: this.timeouts, allowedHosts: [...this.allowedHosts, ...hosts],
      environment: this.environment, egressMode: this.egressMode, onEgress: this.onEgress, maxAttempts: this.defaultMaxAttempts,
    });
  }

  circuitKey(extra) {
    return `integration:${this.providerCode}:${this.connectionId || 'global'}${extra ? `:${extra}` : ''}`;
  }

  timeoutFor(method) {
    return ['GET', 'HEAD'].includes(String(method || 'GET').toUpperCase()) ? this.timeouts.readMs : this.timeouts.writeMs;
  }

  async notify(evento) {
    const base = { providerCode: this.providerCode, connectionId: this.connectionId, mode: this.egressMode, ...evento };
    logger.warn({ providerCode: base.providerCode, host: base.host, decision: base.decision, mode: base.mode }, 'Saída de integração fora do permitido.');
    if (this.onEgress) {
      try { await this.onEgress(base); } catch (err) { logger.warn({ providerCode: base.providerCode, err: err.message }, 'Falha ao registrar a saída bloqueada.'); }
    }
  }

  /** Esquema seguro + lista de hosts, nesta ordem e antes de qualquer rede. `extraHosts` soma os hosts da chamada (config validada). */
  async guard(url, method, extraHosts = []) {
    try {
      assertSecureScheme(url, { environment: this.environment });
    } catch (err) {
      await this.notify({ decision: 'TLS_REQUIRED', code: err.code, host: hostOf(url), method });
      throw err;
    }
    const d = checkEgress({ url, allowedHosts: [...this.allowedHosts, ...extraHosts], mode: this.egressMode });
    if (d.decision === 'ALLOWED') return d;
    await this.notify({ decision: d.decision, code: 'INTEGRATION_EGRESS_BLOCKED', host: d.host, method });
    if (d.decision === 'BLOCKED') throw egressBlocked(d.host);
    return d;
  }

  /** Chamada com timeout, tentativas só para erro transitório e circuit breaker (resilientFetch). */
  async request({ method = 'GET', url, headers, body, timeoutMs, maxAttempts, circuitKey, allowedHosts }) {
    await this.guard(url, method, allowedHosts);
    return resilientFetch({ circuitKey: circuitKey || this.circuitKey(), url, method, headers, body, timeoutMs: timeoutMs || this.timeoutFor(method), maxAttempts: maxAttempts ?? this.defaultMaxAttempts });
  }

  /** Passagem ao fetch global (o mesmo contrato dele), com tempo máximo quando o chamador não trouxe um sinal. `opts.allowedHosts` soma hosts da chamada. */
  async fetch(url, init = {}, opts = {}) {
    await this.guard(url, init.method, opts.allowedHosts);
    const comSinal = init.signal ? init : { ...init, signal: AbortSignal.timeout(this.timeoutFor(init.method)) };
    return fetch(url, comSinal);
  }

  /** HTTPS com certificado de cliente (mTLS): devolve { statusCode, body } com o corpo já lido como JSON. */
  async httpsJson({ method, url, headers, body, agent, allowedHosts }) {
    await this.guard(url, method, allowedHosts);
    return httpsRequestJson({ method, url, headers, body, agent });
  }
}

module.exports = { IntegrationHttpClient, DEFAULT_TIMEOUT_MS, createMtlsAgent };
