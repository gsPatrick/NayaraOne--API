'use strict';

const logger = require('../../../../utils/logger');
const { redactDeep } = require('../../../../shared/redaction');
const { classifyHttpError } = require('../../../integrations/registry/classifyHttpError');
const { operationUnsupported } = require('./channel.errors');
const { CHANNEL_META } = require('./channels');

/**
 * M9-D430 — ChannelAdapter de Marketing (MKT-011): o contrato que o Marketing usa para falar com um canal, em cima do framework de Integrações
 * do bloco B (cliente HTTP único, secret reference, circuit breaker, dispatch com UNKNOWN). Operações: send(message, {idempotencyKey}),
 * publish(post, {idempotencyKey}), findByIdempotencyKey(key), getStatus(providerRef), getMetrics(ref), capabilities(), healthCheck(), revoke(connection)
 * e parseWebhook(headers, rawBody). Cada canal declara em capabilities() as que suporta; chamar uma não declarada é 422.
 * Resultado de send/publish: { channel, mode, sandbox, operation, idempotencyKey, status, providerRef, replayed, duplicate, unknown, error }.
 */
const OPERATIONS = Object.freeze(['send', 'publish', 'findByIdempotencyKey', 'getStatus', 'getMetrics', 'capabilities', 'healthCheck', 'revoke', 'parseWebhook']);
const LOG_LIMIT = 200;

/** Capabilities de um canal: a operação de envio dele, as consultas comuns, revoke, parseWebhook e getMetrics só onde o canal informa métrica. */
function capabilitiesForChannel(channel) {
  const meta = CHANNEL_META[channel];
  const base = [meta.operation, 'findByIdempotencyKey', 'getStatus', 'revoke', 'parseWebhook'];
  return meta.metrics.length ? [...base, 'getMetrics'] : base;
}

class ChannelAdapter {
  constructor({ channel, mode }) {
    this.channel = channel;
    this.mode = mode;
    this.meta = CHANNEL_META[channel];
    this.entries = [];
  }

  get isSandbox() { return this.mode === 'SANDBOX'; }

  /** Operações que este canal suporta (as outras respondem 422 MKT_CHANNEL_OPERATION_UNSUPPORTED). */
  capabilities() { return capabilitiesForChannel(this.channel); }

  supports(operation) { return this.capabilities().includes(operation); }

  assertSupports(operation) {
    if (!this.supports(operation)) throw operationUnsupported(this.channel, operation);
  }

  /** { class, code, retryAfterMs? } do erro HTTP/rede (padrão do bloco B). */
  classifyError(errOrResponse) { return classifyHttpError(errOrResponse); }

  /** Cópia sem segredo (mesma redação do bloco B, M9-D246). */
  redact(value) { return redactDeep(value, { secretsOnly: true }); }

  /** Registro do que o adapter fez, sempre redigido; vai ao log estruturado e fica (limitado) em memória para o teste de contrato. */
  log(event, data = {}) {
    const entry = { event, channel: this.channel, mode: this.mode, ...this.redact(data) };
    this.entries.push(entry);
    if (this.entries.length > LOG_LIMIT) this.entries.shift();
    logger.debug(entry, 'marketing.channel.adapter');
  }

  logEntries() { return [...this.entries]; }

  /** Moldura do resultado de send/publish. */
  result(operation, idempotencyKey, fields) {
    return {
      channel: this.channel, mode: this.mode, sandbox: this.isSandbox, operation, idempotencyKey, status: null, providerRef: null, replayed: false, duplicate: false, unknown: false, error: null, ...fields,
    };
  }

  async send() { throw operationUnsupported(this.channel, 'send'); }

  async publish() { throw operationUnsupported(this.channel, 'publish'); }

  async getMetrics() { throw operationUnsupported(this.channel, 'getMetrics'); }
}

/**
 * Confere se um objeto cumpre o ChannelAdapter: todas as operações existem, as capabilities são nomes conhecidos, send/publish/getMetrics só quando
 * declarados e exatamente uma entre send e publish. Devolve { ok, problems } (não lança).
 */
function assertChannelAdapter(adapter) {
  const problems = [];
  const caps = adapter && typeof adapter.capabilities === 'function' ? adapter.capabilities() : null;
  if (!Array.isArray(caps)) return { ok: false, problems: ['capabilities() não implementado'] };
  for (const op of OPERATIONS) {
    if (typeof adapter[op] !== 'function') problems.push(`operação ausente: ${op}`);
  }
  for (const cap of caps) if (!OPERATIONS.includes(cap)) problems.push(`capability desconhecida: ${cap}`);
  const mensagens = ['send', 'publish'].filter((op) => caps.includes(op));
  if (mensagens.length !== 1) problems.push('o canal precisa declarar exatamente uma entre send e publish');
  for (const obrigatoria of ['findByIdempotencyKey', 'getStatus', 'parseWebhook']) if (!caps.includes(obrigatoria)) problems.push(`capability obrigatória não declarada: ${obrigatoria}`);
  return { ok: problems.length === 0, problems };
}

module.exports = { ChannelAdapter, OPERATIONS, assertChannelAdapter, capabilitiesForChannel };
