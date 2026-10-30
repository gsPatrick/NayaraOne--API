'use strict';

const { ChannelAdapter } = require('../ChannelAdapter');
const { CHANNEL_META, MODES } = require('../channels');
const { CHANNEL_SETTING_DEFAULTS, SLOW_MS_KEY, RETRY_AFTER_KEY } = require('../channel.settings');
const { invalid } = require('../channel.errors');
const { pickScenario, payloadHash, refOf } = require('./sandbox.scenarios');
const { metricsFor } = require('./sandbox.metrics');
const { verifyAndParseWebhook } = require('../webhook/webhook.parse');
const store = require('./sandbox.store');

const defaultSleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/**
 * M9-D430 — implementação SANDBOX do ChannelAdapter, igual para os 9 canais (muda só a operação e as métricas, de channels.js). Determinística: o
 * resultado é função do payload e da chave (hash), sem relógio nem aleatoriedade; os cenários de falha entram por flag (`scenario`) ou cabeçalho de teste;
 * a idempotência é do próprio sandbox (a mesma chave devolve o mesmo registro). Nunca fala com a rede. Tudo o que devolve vem marcado sandbox = true.
 * `opts`: scope (a empresa), slowMs e retryAfterS (parâmetros da empresa), webhookSecrets (segredos aceitos), sleep (injetável nos testes).
 */
class SandboxChannelAdapter extends ChannelAdapter {
  constructor(channel, opts = {}) {
    super({ channel, mode: MODES.SANDBOX });
    this.scope = opts.scope || 'global';
    this.slowMs = Number.isFinite(opts.slowMs) ? opts.slowMs : CHANNEL_SETTING_DEFAULTS[SLOW_MS_KEY];
    this.retryAfterMs = (Number.isFinite(opts.retryAfterS) ? opts.retryAfterS : CHANNEL_SETTING_DEFAULTS[RETRY_AFTER_KEY]) * 1000;
    this.webhookSecrets = opts.webhookSecrets || [];
    this.sleep = opts.sleep || defaultSleep;
  }

  send(message, options) { return this.execute('send', message, options); }

  publish(post, options) { return this.execute('publish', post, options); }

  failure(operation, key, status, httpStatus, code, message, extra = {}) {
    const classified = this.classifyError({ status: httpStatus, retryAfterMs: extra.retryAfterMs });
    return this.result(operation, key, { status, error: { class: classified.class, code, httpStatus, message, ...(extra.retryAfterMs ? { retryAfterMs: extra.retryAfterMs } : {}) } });
  }

  unknown(operation, key, code) {
    return this.result(operation, key, { status: 'UNKNOWN', unknown: true, error: { class: 'UNKNOWN', code, httpStatus: null, message: 'Resposta incerta do canal: confirme antes de repetir.' } });
  }

  success(operation, key, record, extra = {}) {
    return this.result(operation, key, { status: record.status, providerRef: record.providerRef, ...extra });
  }

  async execute(operation, payload, options = {}) {
    this.assertSupports(operation);
    const key = options.idempotencyKey;
    if (typeof key !== 'string' || !key.trim() || key.length > 200) throw invalid('Informe a chave de idempotência.', { campo: 'idempotencyKey' });
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw invalid('Conteúdo inválido para o canal.', { campo: 'payload' });
    const scenario = pickScenario(options);
    this.log('request', { operation, scenario, idempotencyKey: key, payload });
    if (store.isRevoked(this.scope, this.channel)) return this.revokedResult(operation, key);
    const hash = payloadHash(this.channel, operation, payload);
    const record = { providerRef: refOf(this.channel, key, hash), status: CHANNEL_META[this.channel].operation === 'send' ? 'SENT' : 'PUBLISHED', hash, operation };
    const previous = store.getRecord(this.scope, this.channel, key);
    // Chave já registrada: o canal devolve o registro original (nada novo é criado). Um cenário de falha explícito ainda vale.
    if (previous && [null, 'OK', 'SLOW', 'DUPLICATE_KEY'].includes(scenario)) return this.replay(operation, key, previous, scenario === 'DUPLICATE_KEY');
    const result = await this.applyScenario(scenario || 'OK', { operation, key, record });
    this.log('response', { operation, status: result.status, providerRef: result.providerRef, errorCode: result.error && result.error.code });
    return result;
  }

  replay(operation, key, previous, duplicate) {
    return this.success(operation, key, previous, { replayed: true, duplicate, error: duplicate ? { class: 'VALIDATION', code: 'DUPLICATE_KEY', httpStatus: 409, message: 'Chave de idempotência já usada: devolvida a resposta original.' } : null });
  }

  revokedResult(operation, key) {
    return this.failure(operation, key, 'FAILED', 401, 'AUTH_REVOKED', 'Credencial do canal revogada.');
  }

  async applyScenario(scenario, { operation, key, record }) {
    const keep = () => store.putRecord(this.scope, this.channel, key, record);
    switch (scenario) {
      case 'OK': keep(); return this.success(operation, key, record);
      case 'SLOW': await this.sleep(this.slowMs); keep(); return this.success(operation, key, record);
      case 'TIMEOUT': {
        // O pedido chegou ao canal ou não conforme o hash (par/ímpar): é isso que torna o timeout incerto, e sem aleatoriedade.
        if (parseInt(record.hash.slice(0, 2), 16) % 2 === 0) keep();
        return this.unknown(operation, key, 'TIMEOUT');
      }
      case 'UNKNOWN_BUT_PUBLISHED': keep(); return this.unknown(operation, key, 'UNKNOWN_RESPONSE');
      case 'UNKNOWN_NOT_PUBLISHED': return this.unknown(operation, key, 'UNKNOWN_RESPONSE');
      case 'HTTP_429': return this.failure(operation, key, 'FAILED', 429, 'HTTP_429', 'Limite de chamadas do canal atingido.', { retryAfterMs: this.retryAfterMs });
      case 'HTTP_5XX': return this.failure(operation, key, 'FAILED', 503, 'HTTP_503', 'Canal indisponível.');
      case 'AUTH_REVOKED': store.revoke(this.scope, this.channel); return this.revokedResult(operation, key);
      case 'REJECTED': return this.failure(operation, key, 'REJECTED', 422, 'REJECTED', 'O canal recusou o conteúdo.');
      case 'DUPLICATE_KEY': keep(); return this.replay(operation, key, record, true);
      default: throw invalid('Cenário de teste desconhecido.', { campo: 'scenario' });
    }
  }

  async findByIdempotencyKey(key) {
    if (store.isRevoked(this.scope, this.channel)) return { found: false, sandbox: true, error: { class: 'AUTH', code: 'AUTH_REVOKED', httpStatus: 401 } };
    const record = store.getRecord(this.scope, this.channel, key);
    return record ? { found: true, providerRef: record.providerRef, status: record.status, sandbox: true } : { found: false, sandbox: true };
  }

  async getStatus(providerRef) {
    const record = store.findByRef(this.scope, this.channel, providerRef);
    return record ? { found: true, providerRef, status: CHANNEL_META[this.channel].finalStatus, sandbox: true } : { found: false, providerRef, sandbox: true };
  }

  async getMetrics(providerRef) {
    this.assertSupports('getMetrics');
    const record = store.findByRef(this.scope, this.channel, providerRef);
    return record ? { found: true, providerRef, metrics: metricsFor(CHANNEL_META[this.channel].metrics, record.hash), sandbox: true } : { found: false, providerRef, sandbox: true };
  }

  async healthCheck() {
    const ok = !store.isRevoked(this.scope, this.channel);
    return { ok, latencyMs: 0, detail: ok ? 'Sandbox local: não faz chamada externa.' : 'Credencial do canal revogada.', sandbox: true };
  }

  async revoke() {
    store.revoke(this.scope, this.channel);
    this.log('revoke', {});
    return { revoked: true, sandbox: true };
  }

  parseWebhook(headers, rawBody) {
    return verifyAndParseWebhook({ channel: this.channel, headers, rawBody, secrets: this.webhookSecrets });
  }
}

module.exports = { SandboxChannelAdapter };
