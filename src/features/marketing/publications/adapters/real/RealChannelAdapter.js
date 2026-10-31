'use strict';

const { assertConfiguredBaseUrl } = require('../../../../integrations');
const { ChannelAdapter } = require('../ChannelAdapter');
const { MODES } = require('../channels');
const { invalid } = require('../channel.errors');
const { endpointsFor } = require('./real.endpoints');
const { assertReleaseProof } = require('../release/releaseProof');
const { verifyAndParseWebhook } = require('../webhook/webhook.parse');

/** Endereço público do post informado pelo canal (`url` ou `permalink`), só se for http(s); senão null. */
const urlOf = (body) => {
  const url = body && (body.url || body.permalink);
  return typeof url === 'string' && /^https?:\/\/\S+$/i.test(url) ? url : null;
};

const urlField = (body) => (urlOf(body) ? { externalUrl: urlOf(body) } : {});

/** O corpo da resposta, quando for JSON; senão objeto vazio. */
async function bodyOf(response) {
  try { const parsed = await response.json(); return parsed && typeof parsed === 'object' ? parsed : {}; } catch { return {}; }
}

/**
 * M9-D430 — implementação REAL do ChannelAdapter: chamada HTTP pelo cliente único do bloco B (`ctx.http`, que usa o resilientFetch com timeout,
 * lista de hosts permitidos e circuit breaker por connection) e segredo só por secret reference (`ctx.secret`, nunca em log nem em resposta). Só nasce com a prova
 * de canal liberado (releaseProof). `ctx` é o contexto do adapter do bloco B; a URL base vem da config da connection e precisa ser https.
 */
class RealChannelAdapter extends ChannelAdapter {
  constructor(channel, ctx, opts = {}) {
    super({ channel, mode: MODES.PRODUCTION });
    assertReleaseProof(opts.proof, channel);
    this.ctx = ctx;
    this.webhookSecrets = opts.webhookSecrets || [];
  }

  endpoints() {
    const base = String((this.ctx.connection.config || {}).baseUrl || '');
    if (!/^https:\/\/[^\s]+$/i.test(base)) throw invalid('A URL base do canal precisa ser https.', { campo: 'baseUrl' });
    // R3-M3/R3-L5: o destino do token do canal não é escolhido pela empresa: o host da URL base precisa estar na lista fechada da plataforma (integration.egress.provider_hosts), em qualquer modo de saída.
    assertConfiguredBaseUrl({ baseUrl: base, allowedHosts: this.ctx.baseUrlHosts || [], environment: this.ctx.connection.environment });
    return endpointsFor(this.channel, base);
  }

  async headers(idempotencyKey) {
    const secret = await this.ctx.secret('dispatch');
    return { authorization: `Bearer ${secret.value.reveal()}`, 'content-type': 'application/json', accept: 'application/json', ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}) };
  }

  send(message, options) { return this.execute('send', message, options); }

  publish(post, options) { return this.execute('publish', post, options); }

  async execute(operation, payload, options = {}) {
    this.assertSupports(operation);
    if (options.scenario || (options.headers && Object.keys(options.headers).some((h) => h.toLowerCase().startsWith('x-mkt-sandbox')))) throw invalid('Cenário de teste só vale no sandbox.', { campo: 'scenario' });
    const key = options.idempotencyKey;
    if (typeof key !== 'string' || !key.trim() || key.length > 200) throw invalid('Informe a chave de idempotência.', { campo: 'idempotencyKey' });
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw invalid('Conteúdo inválido para o canal.', { campo: 'payload' });
    const urls = this.endpoints();
    this.log('request', { operation, idempotencyKey: key, payload });
    let response;
    try {
      response = await this.ctx.http.request({ method: 'POST', url: urls.create, headers: await this.headers(key), body: JSON.stringify(payload) });
    } catch (err) {
      const classified = this.classifyError(err);
      this.log('response', { operation, errorCode: classified.code });
      // Timeout/rede depois de enviar: o canal pode ter recebido. Nunca presume falha (INT-005): fica UNKNOWN para confirmar por findByIdempotencyKey.
      return this.result(operation, key, { status: 'UNKNOWN', unknown: true, error: { class: classified.class, code: classified.code, httpStatus: null, message: 'Sem resposta do canal: confirme antes de repetir.' } });
    }
    return this.fromResponse(operation, key, response);
  }

  async fromResponse(operation, key, response) {
    const body = await bodyOf(response);
    if (response.status >= 200 && response.status < 300) {
      const ref = body.id || body.providerRef || null;
      if (!ref) return this.result(operation, key, { status: 'UNKNOWN', unknown: true, error: { class: 'UNKNOWN', code: 'NO_REFERENCE', httpStatus: response.status, message: 'O canal respondeu sem identificador: confirme antes de repetir.' } });
      this.log('response', { operation, status: body.status, providerRef: ref });
      return this.result(operation, key, { status: String(body.status || (operation === 'send' ? 'SENT' : 'PUBLISHED')).toUpperCase(), providerRef: String(ref), ...urlField(body) });
    }
    const classified = this.classifyError(response);
    this.log('response', { operation, errorCode: classified.code });
    const status = classified.class === 'VALIDATION' ? 'REJECTED' : 'FAILED';
    return this.result(operation, key, { status, error: { class: classified.class, code: classified.code, httpStatus: response.status, message: 'O canal não aceitou o pedido.', ...(classified.retryAfterMs ? { retryAfterMs: classified.retryAfterMs } : {}) } });
  }

  async read(url) {
    const response = await this.ctx.http.request({ method: 'GET', url, headers: await this.headers(null) });
    return { response, body: await bodyOf(response) };
  }

  async findByIdempotencyKey(key) {
    const { response, body } = await this.read(this.endpoints().byKey(key));
    const item = Array.isArray(body.items) ? body.items[0] : null;
    if (response.status === 404 || !item) return { found: false, sandbox: false };
    return { found: true, providerRef: String(item.id), status: String(item.status || '').toUpperCase(), ...urlField(item), sandbox: false };
  }

  async getStatus(providerRef) {
    const { response, body } = await this.read(this.endpoints().item(providerRef));
    if (response.status === 404) return { found: false, providerRef, sandbox: false };
    return { found: true, providerRef, status: String(body.status || '').toUpperCase(), ...urlField(body), sandbox: false };
  }

  async getMetrics(providerRef) {
    this.assertSupports('getMetrics');
    const { response, body } = await this.read(this.endpoints().metrics(providerRef));
    if (response.status === 404) return { found: false, providerRef, sandbox: false };
    return { found: true, providerRef, metrics: body, sandbox: false };
  }

  /** Nunca lança: falha vira ok:false com a classe do erro. */
  async healthCheck() {
    const started = Date.now();
    try {
      const response = await this.ctx.http.request({ method: 'GET', url: this.endpoints().health, headers: await this.headers(null), timeoutMs: this.ctx.healthCheckTimeoutMs });
      return { ok: response.status >= 200 && response.status < 300, latencyMs: Date.now() - started, detail: `HTTP ${response.status}`, sandbox: false };
    } catch (err) {
      return { ok: false, latencyMs: Date.now() - started, detail: this.classifyError(err).code, sandbox: false };
    }
  }

  async revoke() {
    const response = await this.ctx.http.request({ method: 'POST', url: this.endpoints().revoke, headers: await this.headers(null), body: '{}' });
    return { revoked: response.status >= 200 && response.status < 300, sandbox: false };
  }

  parseWebhook(headers, rawBody) {
    return verifyAndParseWebhook({ channel: this.channel, headers, rawBody, secrets: this.webhookSecrets });
  }
}

module.exports = { RealChannelAdapter };
