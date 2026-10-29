'use strict';

const crypto = require('crypto');
const { AnalyticsAdapter } = require('../analytics.port');
const { classifyHttpError } = require('../../../registry/classifyHttpError');

const STATUS = Object.freeze({ ACCEPTED: 'ACCEPTED', REJECTED: 'REJECTED' });
const idSimulado = (...partes) => `sbx-ana-${crypto.createHash('sha256').update(partes.join('|')).digest('hex').slice(0, 16)}`;

/**
 * analytics-sandbox (M9-D243): métricas e eventos aceitos sem rede, ids determinísticos. O serviço real (analytics ou monitoramento) entra
 * como outro adapter do domínio ANALYTICS sem tocar no resto.
 */
class AnalyticsSandboxAdapter extends AnalyticsAdapter {
  providerCode() { return 'analytics-sandbox'; }

  capabilities() { return ['emitMetric', 'emitEvent', 'queryHealth']; }

  supportedVersions() { return ['v1']; }

  async healthCheck() { return { ok: true, latencyMs: 0, detail: 'Sandbox local: não faz chamada externa.' }; }

  classifyError(e) { return classifyHttpError(e); }

  mapStatus(externalStatus) {
    const s = String(externalStatus ?? '').toUpperCase();
    return Object.prototype.hasOwnProperty.call(STATUS, s) ? STATUS[s] : null;
  }

  async emitMetric(_ctx, request) {
    return { externalRequestId: null, externalResourceId: idSimulado('metric', request.name, JSON.stringify(request.tags || {})), status: STATUS.ACCEPTED };
  }

  async emitEvent(_ctx, request) {
    return { externalRequestId: null, externalResourceId: idSimulado('event', request.name, JSON.stringify(request.properties || {})), status: STATUS.ACCEPTED };
  }

  async queryHealth() {
    return { externalRequestId: null, externalResourceId: null, status: STATUS.ACCEPTED };
  }
}

module.exports = { AnalyticsSandboxAdapter, STATUS };
