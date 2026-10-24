'use strict';

// Marco 8 Fase 12 (addendum fiscal do Caderno Técnico) — adapter de NFS-e, MESMO espírito
// arquitetural de FinancingProviderAdapter.js (Fase 0): nenhum provedor real de NFS-e está
// contratado ainda, então o domínio só conhece esta interface determinística/sandbox. "Adapter
// versionado" (citação literal do Caderno) é satisfeito pelo campo `adapter_version` persistido
// em cada InvoiceRequest, não por múltiplas classes concorrentes — não há ainda um segundo
// provedor pra justificar um registry como o de financiamento (Fase 0).
//
// Máquina de estados: REQUESTED → SUBMITTED → AUTHORIZED/REJECTED/CANCELED. Determinístico por
// tempo decorrido desde a submissão, mesmo truque do SandboxFinancingProviderAdapter — permite
// observar a progressão num teste real sem mockar relógio.

const AUTHORIZE_THRESHOLD_MS = 1500;

class SandboxNfseAdapter {
  version() {
    return 'sandbox-v1';
  }

  // Submete o pedido de nota ao "provedor" — nunca falha de propósito (determinístico), mas o
  // chamador ainda trata timeout/erro de rede como UNKNOWN (mesmo padrão de submissions.service.js
  // Fase 5), já que uma integração real poderia falhar nesse ponto.
  async requestInvoice(req) {
    const submittedAt = Date.now();
    const externalId = `nfse-sandbox-${req?.idempotencyKey || submittedAt}-${submittedAt}`;
    return { externalId, status: 'SUBMITTED', raw: { sandbox: true, submittedAt, req } };
  }

  async getInvoiceStatus(externalId) {
    const match = /-(\d+)$/.exec(String(externalId || ''));
    const submittedAt = match ? Number(match[1]) : Date.now();
    const elapsed = Date.now() - submittedAt;
    const status = elapsed >= AUTHORIZE_THRESHOLD_MS ? 'AUTHORIZED' : 'SUBMITTED';
    return {
      externalId,
      status,
      rawProviderStatus: status,
      officialNumber: status === 'AUTHORIZED' ? `NFSE-${externalId.slice(-8)}` : null,
      raw: { sandbox: true, elapsedMs: elapsed },
    };
  }

  async cancelInvoice(externalId) {
    return { externalId, status: 'CANCELED', raw: { sandbox: true } };
  }
}

module.exports = { SandboxNfseAdapter };
