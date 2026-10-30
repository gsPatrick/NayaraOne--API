'use strict';

const { SiteAdapter } = require('../site.port');
const { classifyHttpError } = require('../../../registry/classifyHttpError');
const { raiseFault, readWire, faultOf, erroHttp: erroDoSite } = require('../../../registry/sandboxFaults');
const { hmacWithTimestamp } = require('../../../registry/webhookVerifiers');
const { texto } = require('../../../registry/webhookSchemas');
const { STATUS, RANK, WIRE_TO_INTERNAL } = require('../site.status');
const { siteEvent } = require('../site.event');
const store = require('./site.sandbox.store');

const EVENT_SCHEMA = Object.freeze({
  type: 'object',
  required: ['id', 'type', 'page'],
  properties: {
    id: texto(160),
    type: texto(80),
    api_version: texto(16),
    occurredAt: texto(40),
    page: { type: 'object', additionalProperties: false, required: ['key', 'publicationId', 'status'], properties: { key: texto(160), publicationId: texto(160), status: { type: 'string', pattern: '^[A-Za-z_]{1,40}$' }, reason: texto(300) } },
  },
});

/**
 * site-sandbox (M9-D259 3.2 item 5): gerenciador de site simulado, sem rede e determinístico. Publicar responde como o site real (202, "pending"): a página só aparece como `live` depois do
 * atraso `config.sandbox_publish_delay_ms` (padrão 0) e quem consulta `getPageStatus` ou recebe o webhook assinado (HMAC com horário) é que sabe. Falhas por cabeçalho `x-sandbox-fail`
 * (timeout, 429, 401, 500, resposta malformada) e `config.sandbox_fault` (TIMEOUT_AFTER_SEND: a página é criada e a resposta não volta). `config.sandbox_immediate_live` faz a RESPOSTA da publicação
 * já dizer `live` (o HTTP 200 que o ERP não pode tomar como confirmação). Versões suportadas: v1. Criticidade MEDIUM.
 */
class SiteSandboxAdapter extends SiteAdapter {
  providerCode() { return 'site-sandbox'; }

  capabilities() { return ['publishPage', 'unpublishPage', 'getPageStatus']; }

  supportedVersions() { return ['v1']; }

  supportsIdempotency(operation) { return operation === 'publishPage'; }

  classifyError(e) { return classifyHttpError(e); }

  mapStatus(externalStatus) {
    const s = String(externalStatus ?? '').toLowerCase();
    return Object.prototype.hasOwnProperty.call(WIRE_TO_INTERNAL, s) ? WIRE_TO_INTERNAL[s] : (Object.values(STATUS).includes(s.toUpperCase()) ? s.toUpperCase() : null);
  }

  statusRank() { return { ...RANK }; }

  webhookVerifier() { return hmacWithTimestamp(); }

  webhookSchemas() { return { '*': { v1: EVENT_SCHEMA } }; }

  toInternalEvent(payload) {
    return siteEvent({ pageKey: payload.page.key, publicationId: payload.page.publicationId, externalStatus: payload.page.status, occurredAt: payload.occurredAt, reason: payload.page.reason });
  }

  async healthCheck(ctx, opts) {
    try {
      return faultOf(ctx || this.ctx, opts || {}) ? { ok: false, latencyMs: 0, detail: 'Falha simulada pelo sandbox.' } : { ok: true, latencyMs: 0, detail: 'Sandbox local: não faz chamada externa.' };
    } catch { return { ok: false, latencyMs: 0, detail: 'Falha ao testar o sandbox.' }; }
  }

  delayOf(ctx) { return Number(((ctx.connection.config) || {}).sandbox_publish_delay_ms) || 0; }

  /** Resposta do site já "lida" do fio: id da publicação como recurso, id da página e o status no vocabulário do site. */
  answer(ctx, request, page, wireStatus) {
    const lida = readWire(ctx, request, { id: page.publicationId, status: wireStatus });
    return { externalRequestId: `req-${page.publicationId}`, externalResourceId: lida.id, status: this.normalizeStatus(lida.status), pageId: page.pageId };
  }

  async publishPage(ctx, request, meta) {
    await raiseFault(ctx, request, 'write');
    const chave = (meta && meta.idempotencyKey) || `${request.pageKey}|${request.contentHash || ''}`;
    const { page } = store.publish(ctx.connection.id, chave, request, this.delayOf(ctx));
    if (store.afterSendTimeout(ctx, chave)) throw Object.assign(new Error('Tempo esgotado esperando o site.'), { code: 'ETIMEDOUT', name: 'TimeoutError' });
    const imediato = ((ctx.connection.config) || {}).sandbox_immediate_live === true;
    return this.answer(ctx, request, page, imediato ? 'live' : 'pending');
  }

  async unpublishPage(ctx, request) {
    await raiseFault(ctx, request, 'write');
    const page = store.unpublish(ctx.connection.id, request.pageKey);
    // Página que o site não conhece: a remoção é idempotente e responde removida, sem erro.
    if (!page) return { externalRequestId: null, externalResourceId: null, status: this.normalizeStatus('removed'), pageId: null };
    return this.answer(ctx, request, page, 'removed');
  }

  async getPageStatus(ctx, request) {
    await raiseFault(ctx, request, 'read');
    store.log(ctx.connection.id, 'getPageStatus', request.pageKey);
    const page = store.find(ctx.connection.id, request.pageKey);
    if (!page) throw erroDoSite(404, 'Página não encontrada no site.');
    return this.answer(ctx, request, page, store.stateAt(page));
  }

  /** Estado da página pelo `pageKey` no site (a mesma leitura do getPageStatus, que fica registrada como consulta). */
  readState(ctx, page) {
    store.log(ctx.connection.id, 'getPageStatus', page.pageKey);
    return { found: true, externalResourceId: page.publicationId, status: store.stateAt(page) };
  }

  /** Reconciliação (M9-D215), 1ª consulta: a publicação feita com a chave de idempotência, se o site a recebeu; o estado dela vem do status da página. */
  async findByIdempotencyKey(ctx, request) {
    const page = store.findByIdempotencyKey(ctx.connection.id, request.idempotencyKey);
    return page ? this.readState(ctx, page) : { found: false };
  }

  /** Reconciliação pela referência de negócio: o status da página pelo `pageKey`. Só vale se a página no site tem o MESMO conteúdo do envio (`contentHash`); uma versão antiga no ar não prova que a nova chegou. */
  async findByReference(ctx, request) {
    if (!request.pageKey) return { found: false };
    const page = store.find(ctx.connection.id, request.pageKey);
    if (!page || (request.contentHash && page.contentHash !== request.contentHash)) return { found: false };
    return this.readState(ctx, page);
  }
}

module.exports = { SiteSandboxAdapter, SANDBOX_FAULT_EXAMPLES: ['timeout', '429', 'auth', '500', 'malformed_json'] };
