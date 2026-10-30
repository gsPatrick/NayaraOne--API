'use strict';

const crypto = require('node:crypto');
const { PortalAdapter } = require('../portal.port');
const { classifyHttpError } = require('../../../registry/classifyHttpError');
const { hmacWithTimestamp } = require('../../../registry/webhookVerifiers');
const { statusEventSchemas } = require('../../../registry/webhookSchemas');
const store = require('./portal.sandbox.store');

const STATUS = Object.freeze({ PUBLISHED: 'PUBLISHED', ACTIVE: 'PUBLISHED', UPDATED: 'UPDATED', UNPUBLISHED: 'UNPUBLISHED', REMOVED: 'UNPUBLISHED', REJECTED: 'REJECTED' });

/**
 * Base dos portais sandbox da M9-D232 (sem rede): cada portal declara só o que muda entre portais, o código, o prefixo dos ids, o mapping (campos, obrigatórios e enums), a
 * versão do mapping e as capacidades. Aplica o mapping ao pedido minimizado, recusa o que falta e guarda o anúncio no vocabulário do portal.
 */
class PortalSandboxBase extends PortalAdapter {
  idPrefix() { throw new Error('idPrefix() não implementado'); }

  capabilities() { return ['publishListing', 'updateListing', 'unpublishListing', 'getListingStatus']; }

  supportedVersions() { return ['v1']; }

  webhookVerifier() { return hmacWithTimestamp(); }

  webhookSchemas() { return statusEventSchemas(); }

  supportsIdempotency(operation) { return operation === 'publishListing'; }

  async healthCheck(ctx) {
    if (ctx && ctx.connection && store.isDown(ctx.connection.id)) return { ok: false, latencyMs: 0, detail: 'Portal fora do ar.' };
    return { ok: true, latencyMs: 0, detail: 'Sandbox local: não faz chamada externa.' };
  }

  classifyError(e) { return classifyHttpError(e); }

  mapStatus(externalStatus) {
    const s = String(externalStatus ?? '').toUpperCase();
    return Object.prototype.hasOwnProperty.call(STATUS, s) ? STATUS[s] : null;
  }

  externalIdFor(listingRef) { return `${this.idPrefix()}-${crypto.createHash('sha256').update(String(listingRef)).digest('hex').slice(0, 14)}`; }

  /** Aplica o mapping; falta de campo obrigatório é recusa do pedido (422), sem guardar nada. */
  prepare(request) {
    const mapped = this.mapListing(request);
    if (mapped.missing.length) throw Object.assign(new Error(`Faltam dados exigidos pelo portal: ${mapped.missing.join(', ')}.`), { status: 422, statusCode: 422, code: 'INTEGRATION_PORTAL_REQUIRED_FIELD_MISSING' });
    return mapped;
  }

  async publishListing(ctx, request, meta) {
    const id = ctx.connection.id;
    store.assertUp(id);
    const mapped = this.prepare(request);
    const externalId = this.externalIdFor(request.listingRef);
    store.registrar(id, 'publishListing', externalId);
    store.salvar(id, externalId, { status: 'PUBLISHED', payload: mapped.payload });
    if (meta && meta.idempotencyKey) store.lembrarChave(id, meta.idempotencyKey, externalId);
    return { externalRequestId: null, externalResourceId: externalId, status: 'PUBLISHED' };
  }

  async updateListing(ctx, request) {
    const id = ctx.connection.id;
    store.assertUp(id);
    const atual = store.achar(id, request.externalResourceId);
    if (!atual) throw store.erroHttp(404, 'Anúncio não encontrado no portal.');
    const mapped = this.prepare(request);
    store.registrar(id, 'updateListing', request.externalResourceId);
    store.salvar(id, request.externalResourceId, { status: atual.status === 'REJECTED' ? 'REJECTED' : 'PUBLISHED', payload: mapped.payload, rejectionReason: atual.rejectionReason });
    return { externalRequestId: null, externalResourceId: request.externalResourceId, status: 'UPDATED' };
  }

  async unpublishListing(ctx, request) {
    const id = ctx.connection.id;
    store.assertUp(id);
    store.registrar(id, 'unpublishListing', request.externalResourceId);
    const atual = store.achar(id, request.externalResourceId);
    // Falha injetada: o portal responde 200, mas o anúncio continua no ar (a resposta de remoção não é a prova da remoção).
    if (atual && !store.consumeIgnoreUnpublish(id)) store.setStatus(id, request.externalResourceId, 'UNPUBLISHED');
    return { externalRequestId: null, externalResourceId: request.externalResourceId, status: 'UNPUBLISHED' };
  }

  async getListingStatus(ctx, request) {
    const id = ctx.connection.id;
    store.assertUp(id);
    store.registrar(id, 'getListingStatus', request.externalResourceId);
    const atual = store.achar(id, request.externalResourceId);
    if (!atual) throw store.erroHttp(404, 'Anúncio não encontrado no portal.');
    return { externalRequestId: null, externalResourceId: request.externalResourceId, status: atual.status, rejectionReason: atual.rejectionReason };
  }

  /** Consulta pela chave de idempotência (M9-D215): o anúncio que o portal criou com essa chave. */
  async findByIdempotencyKey(ctx, request) {
    const externalId = store.idPorChave(ctx.connection.id, request.idempotencyKey);
    const atual = externalId ? store.achar(ctx.connection.id, externalId) : null;
    return atual ? { found: true, externalResourceId: externalId, status: atual.status } : { found: false };
  }
}

module.exports = { PortalSandboxBase };
