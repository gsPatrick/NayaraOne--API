'use strict';

const crypto = require('crypto');
const AppError = require('../../../utils/AppError');

// Marco 8 — Correspondente Bancário + Financiamentos (contrato 00000009, Anexo I,
// "CONSTITUIÇÃO DO ERP NAYARA ONE — CORRESPONDENTE BANCÁRIO + NC + FINANCIAMENTOS").
//
// Interface comum (duck-typed, MESMO estilo arquitetural já usado em
// src/features/procurement/adapters/InsuranceAdapter.js / BankAdapter.js / SignatureAdapter.js —
// não é coincidência, é o padrão estabelecido do projeto para qualquer integração de provider
// externo):
//   capabilities() -> { simulate, submitCase, getCaseStatus, uploadDocument, requestAppraisal, verifyWebhook }
//   async simulate(req) -> { externalId, rate, installments, monthlyPayment, raw }
//   async submitCase(req) -> { externalId, status, raw }
//   async getCaseStatus(externalId) -> { externalId, status, rawProviderStatus, raw }
//   async uploadDocument(req)      -> opcional, { externalDocumentId, raw }
//   async requestAppraisal(req)    -> opcional, { externalId, status, raw }
//   verifyWebhook(rawBody, headers, secret) -> boolean (síncrono, mesmo padrão HMAC de
//   verifyInsuranceWebhookSignature em procurement/insurance.controller.js)
//
// "Provider sempre atrás de adapter/capability matrix; domínio não depende de API específica."
// "Provider sem API usa workflow manual assistido mantendo o mesmo modelo interno."
// "Secrets ficam em cofre/secret manager, nunca no código ou log." — por isso nenhuma classe
// aqui recebe secret hard-coded; quem resolve o adapter (resolveFinancingProviderAdapter.js)
// é quem lê o secret via settings.service (getDecryptedSetting), nunca este arquivo.

const FINANCING_WEBHOOK_HEADER = 'x-webhook-signature';

// Mesmo esquema HMAC-SHA256 já usado no webhook de seguro (procurement/insurance.controller.js)
// e no webhook da Clicksign (legal.controller.js#verifyProviderWebhookSignature) — comparação
// sempre com crypto.timingSafeEqual, nunca `===` (evita vazar timing de comparação).
function computeHmacSha256Hex(secret, rawBody) {
  return crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
}

function verifyHmacSignature(rawBody, headers, secret) {
  if (!secret || !rawBody || rawBody.length === 0) return false;
  const received = headers ? headers[FINANCING_WEBHOOK_HEADER] : null;
  if (!received || typeof received !== 'string') return false;
  const receivedHex = received.startsWith('sha256=') ? received.slice('sha256='.length) : received;

  const expectedHex = computeHmacSha256Hex(secret, rawBody);

  let expectedBuffer;
  let receivedBuffer;
  try {
    expectedBuffer = Buffer.from(expectedHex, 'hex');
    receivedBuffer = Buffer.from(receivedHex, 'hex');
  } catch {
    return false;
  }
  if (expectedBuffer.length !== receivedBuffer.length) return false;
  return crypto.timingSafeEqual(expectedBuffer, receivedBuffer);
}

// ---------------------------------------------------------------------------------------------
// SANDBOX — único adapter "real" desta Fase 0. Determinístico (nada de Math.random/Date "puro"
// sem seed): o `externalId` embute o instante da submissão, e getCaseStatus deriva o status a
// partir do tempo decorrido — assim um teste E2E real (Playwright) consegue observar a
// progressão SUBMITTED → UNDER_ANALYSIS → APPROVED sem precisar mockar o relógio, só esperando
// alguns segundos entre as chamadas, igual um provider real levaria algum tempo processando.
// ---------------------------------------------------------------------------------------------
const SANDBOX_STATUS_THRESHOLDS_MS = {
  UNDER_ANALYSIS: 2000, // a partir de 2s desde a submissão
  APPROVED: 6000, // a partir de 6s desde a submissão
};

class SandboxFinancingProviderAdapter {
  capabilities() {
    return {
      simulate: true,
      submitCase: true,
      getCaseStatus: true,
      uploadDocument: true,
      requestAppraisal: true,
      verifyWebhook: true,
    };
  }

  async simulate(req) {
    const amount = Number(req?.amount) || 0;
    const termMonths = Number(req?.termMonths) || 1;
    // Taxa fixa fictícia (configurável via req pra permitir diferentes cenários de teste), nunca
    // uma chamada de rede real — "Cotação simulada (sandbox)", mesmo espírito de
    // SandboxInsuranceAdapter#quote.
    const rate = Number(req?.simulatedRate) || 0.012; // 1,2% a.m. fictício
    const monthlyPayment = amount > 0
      ? Number(((amount * rate) / (1 - (1 + rate) ** -termMonths)).toFixed(2))
      : 0;
    return {
      externalId: `sandbox-sim-${req?.idempotencyKey || Date.now()}`,
      rate,
      installments: termMonths,
      monthlyPayment,
      raw: { sandbox: true, req },
    };
  }

  async submitCase(req) {
    // Timestamp embutido no externalId — é isso que permite getCaseStatus ser determinístico
    // por tempo decorrido, sem precisar de nenhuma tabela ainda (Fase 0 não cria schema).
    const submittedAt = Date.now();
    const externalId = `sandbox-case-${req?.idempotencyKey || submittedAt}-${submittedAt}`;
    return { externalId, status: 'SUBMITTED', raw: { sandbox: true, submittedAt, req } };
  }

  async getCaseStatus(externalId) {
    const match = /-(\d+)$/.exec(String(externalId || ''));
    const submittedAt = match ? Number(match[1]) : Date.now();
    const elapsed = Date.now() - submittedAt;
    let status = 'SUBMITTED';
    if (elapsed >= SANDBOX_STATUS_THRESHOLDS_MS.APPROVED) status = 'APPROVED';
    else if (elapsed >= SANDBOX_STATUS_THRESHOLDS_MS.UNDER_ANALYSIS) status = 'UNDER_ANALYSIS';
    return { externalId, status, rawProviderStatus: status, raw: { sandbox: true, elapsedMs: elapsed } };
  }

  async uploadDocument(req) {
    return { externalDocumentId: `sandbox-doc-${req?.idempotencyKey || Date.now()}`, raw: { sandbox: true, req } };
  }

  async requestAppraisal(req) {
    return { externalId: `sandbox-appraisal-${req?.idempotencyKey || Date.now()}`, status: 'REQUESTED', raw: { sandbox: true, req } };
  }

  // Sandbox aceita assinatura HMAC válida contra o secret de desenvolvimento configurado — não
  // é "sempre true", porque os próprios testes de segurança desta fase precisam de um provider
  // que valide de verdade sem depender de rede nenhuma.
  verifyWebhook(rawBody, headers, secret) {
    return verifyHmacSignature(rawBody, headers, secret);
  }
}

// ---------------------------------------------------------------------------------------------
// MANUAL — "Provider sem API usa workflow manual assistido mantendo o mesmo modelo interno."
// Nenhum método faz chamada HTTP; cada ação só registra que uma pessoa precisa agir fora do
// sistema (ex: levar documentação físico/digital ao banco, ligar pro gerente). A evolução real
// do status desse tipo de caso é responsabilidade de uma ação humana explícita — Fase 6
// (webhooks/status) do checklist do Marco 8 vai expor o endpoint pra isso; aqui só o contrato
// do adapter já reflete corretamente que ESTE provider nunca evolui status sozinho.
// ---------------------------------------------------------------------------------------------
class ManualWorkflowFinancingProviderAdapter {
  capabilities() {
    return {
      simulate: false,
      submitCase: true,
      getCaseStatus: true,
      uploadDocument: false,
      requestAppraisal: false,
      verifyWebhook: false,
    };
  }

  async simulate() {
    throw AppError.internal(
      'Provider de workflow manual não suporta simulação automática — a proposta precisa ser levantada diretamente com o banco.',
      'CORRESPONDENT_PROVIDER_NOT_IMPLEMENTED'
    );
  }

  async submitCase(req) {
    return {
      externalId: `manual-${req?.idempotencyKey || Date.now()}`,
      status: 'PENDING_MANUAL_ACTION',
      raw: { manual: true, req },
    };
  }

  // Sem backend real pra consultar: o status permanece "PENDING_MANUAL_ACTION" até alguém
  // atualizar manualmente (ação humana, fora do escopo desta Fase 0 — ver comentário da classe).
  async getCaseStatus(externalId) {
    return {
      externalId,
      status: 'PENDING_MANUAL_ACTION',
      rawProviderStatus: 'PENDING_MANUAL_ACTION',
      raw: { manual: true },
    };
  }

  async uploadDocument() {
    throw AppError.internal(
      'Provider de workflow manual não aceita upload de documento automatizado.',
      'CORRESPONDENT_PROVIDER_NOT_IMPLEMENTED'
    );
  }

  async requestAppraisal() {
    throw AppError.internal(
      'Provider de workflow manual não suporta solicitação automática de avaliação.',
      'CORRESPONDENT_PROVIDER_NOT_IMPLEMENTED'
    );
  }

  // Provider manual não recebe webhook nenhum (não há API do lado do banco) — chamado por
  // engano, sempre nega.
  verifyWebhook() {
    return false;
  }
}

module.exports = {
  verifyHmacSignature,
  SandboxFinancingProviderAdapter,
  ManualWorkflowFinancingProviderAdapter,
};
