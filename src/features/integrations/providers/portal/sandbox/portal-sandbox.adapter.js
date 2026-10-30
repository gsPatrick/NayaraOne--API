'use strict';

const crypto = require('crypto');
const { PortalAdapter } = require('../portal.port');
const { classifyHttpError } = require('../../../registry/classifyHttpError');
const { hmacWithTimestamp } = require('../../../registry/webhookVerifiers');
const { statusEventSchemas } = require('../../../registry/webhookSchemas');

const STATUS = Object.freeze({ PUBLISHED: 'PUBLISHED', UPDATED: 'UPDATED', UNPUBLISHED: 'UNPUBLISHED', REJECTED: 'REJECTED' });

const idSimulado = (ref) => `sbx-listing-${crypto.createHash('sha256').update(String(ref)).digest('hex').slice(0, 16)}`;

/**
 * portal-sandbox (M9-D210 3.1): portal imobiliário simulado, sem rede. O mapeamento por portal e a versão do anúncio são
 * da M9-D232; aqui fica a base para o contrato e para os testes.
 */
class PortalSandboxAdapter extends PortalAdapter {
  providerCode() { return 'portal-sandbox'; }

  capabilities() { return ['publishListing', 'updateListing', 'unpublishListing', 'getListingStatus']; }

  supportedVersions() { return ['v1']; }

  /** Webhook do sandbox: HMAC-SHA256 com horário assinado (cabeçalho x-signature: t=...,v1=...), M9-D211 3.3. */
  webhookVerifier() { return hmacWithTimestamp(); }

  /** Esquema do evento de status (M9-D213 3.3). */
  webhookSchemas() { return statusEventSchemas(); }

  /** O id do anúncio sai do `listingRef`: publicar a mesma referência duas vezes devolve o mesmo anúncio (M9-D222 cenário 7). */
  supportsIdempotency(operation) { return operation === 'publishListing'; }

  async healthCheck() { return { ok: true, latencyMs: 0, detail: 'Sandbox local: não faz chamada externa.' }; }

  classifyError(e) { return classifyHttpError(e); }

  mapStatus(externalStatus) {
    const s = String(externalStatus ?? '').toUpperCase();
    return Object.prototype.hasOwnProperty.call(STATUS, s) ? STATUS[s] : null;
  }

  async publishListing(_ctx, request) {
    return { externalRequestId: null, externalResourceId: idSimulado(request.listingRef), status: STATUS.PUBLISHED };
  }

  async updateListing(_ctx, request) {
    return { externalRequestId: null, externalResourceId: request.externalResourceId, status: STATUS.UPDATED };
  }

  async unpublishListing(_ctx, request) {
    return { externalRequestId: null, externalResourceId: request.externalResourceId, status: STATUS.UNPUBLISHED };
  }

  async getListingStatus(_ctx, request) {
    return { externalRequestId: null, externalResourceId: request.externalResourceId, status: STATUS.PUBLISHED };
  }
}

module.exports = { PortalSandboxAdapter, STATUS };
