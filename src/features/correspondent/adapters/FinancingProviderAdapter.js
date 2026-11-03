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

const SANDBOX_SUBMISSIONS = new Map();

// Cenários de falha do sandbox (DoD "sandbox/failure drills"), escolhidos pelos CENTAVOS do valor da
// operação: assim dá para ensaiar UNKNOWN, recusa e pendência do cliente sem mock de código.
//   R$ x,13 → o provider falha ao receber o caso (erro)
//   R$ x,14 → o provider não responde a tempo (timeout → UNKNOWN)
//   R$ x,15 → o banco recusa (a consulta devolve DENIED)
//   R$ x,16 → o banco pede documento do cliente (a consulta devolve DOC_PENDING)
// Qualquer outro valor segue o fluxo normal (SUBMITTED → UNDER_ANALYSIS → APPROVED).
const SANDBOX_SCENARIO_BY_CENTS = { 13: 'FAIL', 14: 'TIMEOUT', 15: 'DENIED', 16: 'DOC' };
function sandboxScenario(amount) {
  const cents = Math.round((Number(amount) || 0) * 100) % 100;
  return SANDBOX_SCENARIO_BY_CENTS[cents] || null;
}

class SandboxFinancingProviderAdapter {
  capabilities() {
    return {
      simulate: true,
      submitCase: true,
      getCaseStatus: true,
      uploadDocument: true,
      requestAppraisal: true,
      cancelCase: true,
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

  // Consulta por chave de idempotência (o que um provider real faz com a "referência do cliente").
  // O sandbox guarda as submissões que aceitou em memória: depois de um reinício ele não lembra,
  // e responder "não encontrado" é o comportamento esperado de um sandbox efêmero.
  // Cancela o caso no provider (contrato opcional `cancelCase`). O sandbox só registra o cancelamento.
  async cancelCase(externalCaseId) {
    for (const [key, value] of SANDBOX_SUBMISSIONS.entries()) {
      if (value.externalId === externalCaseId) SANDBOX_SUBMISSIONS.set(key, { ...value, status: 'CANCELED' });
    }
    return { externalId: externalCaseId, canceled: true };
  }

  async findSubmissionByKey(idempotencyKey) {
    const known = SANDBOX_SUBMISSIONS.get(String(idempotencyKey || ''));
    return known ? { found: true, externalId: known.externalId, status: known.status } : { found: false };
  }

  async submitCase(req) {
    // Timestamp embutido no externalId — é isso que permite getCaseStatus ser determinístico
    // por tempo decorrido, sem precisar de nenhuma tabela ainda (Fase 0 não cria schema).
    // Idempotente pela chave: reenviar a mesma chave (ex.: o worker repete porque o commit local
    // falhou) devolve o mesmo caso, como um provider real que respeita a chave de idempotência.
    const known = req?.idempotencyKey ? SANDBOX_SUBMISSIONS.get(String(req.idempotencyKey)) : null;
    if (known) return { externalId: known.externalId, status: 'SUBMITTED', raw: { sandbox: true, replayed: true } };
    const scenario = sandboxScenario(req?.amount);
    if (scenario === 'FAIL') throw new Error('Falha simulada do sandbox: o provider não conseguiu receber o caso.');
    if (scenario === 'TIMEOUT') await new Promise((resolve) => setTimeout(resolve, 30000));
    const submittedAt = Date.now();
    const externalId = `sandbox-case-${req?.idempotencyKey || submittedAt}${scenario === 'DENIED' ? '-DENIED' : ''}${scenario === 'DOC' ? '-DOC' : ''}-${submittedAt}`;
    if (req?.idempotencyKey) SANDBOX_SUBMISSIONS.set(String(req.idempotencyKey), { externalId, status: 'SUBMITTED' });
    return { externalId, status: 'SUBMITTED', raw: { sandbox: true, submittedAt, req } };
  }

  async getCaseStatus(externalId) {
    const match = /-(\d+)$/.exec(String(externalId || ''));
    const submittedAt = match ? Number(match[1]) : Date.now();
    const elapsed = Date.now() - submittedAt;
    let status = 'SUBMITTED';
    if (elapsed >= SANDBOX_STATUS_THRESHOLDS_MS.APPROVED) status = 'APPROVED';
    else if (elapsed >= SANDBOX_STATUS_THRESHOLDS_MS.UNDER_ANALYSIS) status = 'UNDER_ANALYSIS';
    if (/-DENIED-\d+$/.test(String(externalId)) && elapsed >= SANDBOX_STATUS_THRESHOLDS_MS.UNDER_ANALYSIS) status = 'DENIED';
    if (/-DOC-\d+$/.test(String(externalId)) && elapsed >= SANDBOX_STATUS_THRESHOLDS_MS.UNDER_ANALYSIS) status = 'DOC_PENDING';
    return { externalId, status, rawProviderStatus: status, raw: { sandbox: true, elapsedMs: elapsed } };
  }

  async uploadDocument(req) {
    return { externalDocumentId: `sandbox-doc-${req?.idempotencyKey || Date.now()}`, raw: { sandbox: true, req } };
  }

  // Determinístico, como os demais métodos sandbox: sem worker/fila assíncrona nesta fase
  // (mesma simplificação já documentada na Fase 5 de submissões), a avaliação "conclui" na hora,
  // com um valor calculado a partir do valor de referência informado (±3%, variação fixa por
  // hash do idempotencyKey — nunca aleatório de verdade, pra o teste poder reproduzir o valor
  // exato). Puramente informativo: quem chama este método NUNCA deve escrever `value` de volta
  // no imóvel/oferta (invariante do Caderno).
  async requestAppraisal(req) {
    const externalId = `sandbox-appraisal-${req?.idempotencyKey || Date.now()}`;
    const referenceValue = Number(req?.referenceValue) || 0;
    const seed = String(req?.idempotencyKey || externalId)
      .split('')
      .reduce((acc, ch) => acc + ch.charCodeAt(0), 0);
    // -3% a +3% sem o 0%: com `(seed % 7) - 3`, 1 em cada 7 chaves dava variação zero e o valor
    // avaliado saía idêntico ao de referência — o teste do invariante "avaliação nunca altera o
    // preço" (CORRESPONDENT-APR-03) ficava sem prova nesses casos (falhou no CI run 39146923044).
    const VARIANCES = [-3, -2, -1, 1, 2, 3];
    const variancePct = VARIANCES[seed % VARIANCES.length] / 100;
    const value = referenceValue > 0 ? Number((referenceValue * (1 + variancePct)).toFixed(2)) : null;
    return {
      externalId,
      status: 'COMPLETED',
      value,
      raw: { sandbox: true, req, variancePct },
    };
  }

  // Sandbox aceita assinatura HMAC válida contra o secret de desenvolvimento configurado — não
  // é "sempre true", porque os próprios testes de segurança desta fase precisam de um provider
  // que valide de verdade sem depender de rede nenhuma.
  verifyWebhook(rawBody, headers, secret) {
    return verifyHmacSignature(rawBody, headers, secret);
  }

  // Mapa de status por provider — citação literal do Caderno (Marco 8, Guia do Marcelo,
  // "Status mapping"): "RECEIVED→SUBMITTED, ANALYSIS→UNDER_ANALYSIS, DOC_PENDING→PENDING_CUSTOMER,
  // APPROVED→APPROVED, DENIED→REJECTED, CONTRACTED→COMPLETED." Além desses, PROPERTY_PENDING→PENDING_PROPERTY,
  // CONTRACTING→CONTRACTING e CANCELED/CANCELLED→CANCELED, para todos os estados internos serem alcançáveis. Retorna null (nunca lança) quando o
  // status bruto não é reconhecido — o chamador decide o que fazer (nunca perder o evento bruto).
  normalizeProviderStatus(rawStatus) {
    const MAP = {
      RECEIVED: 'SUBMITTED',
      SUBMITTED: 'SUBMITTED',
      UNDER_ANALYSIS: 'UNDER_ANALYSIS',
      ANALYSIS: 'UNDER_ANALYSIS',
      DOC_PENDING: 'PENDING_CUSTOMER',
      APPROVED: 'APPROVED',
      DENIED: 'REJECTED',
      CONTRACTED: 'COMPLETED',
      PROPERTY_PENDING: 'PENDING_PROPERTY',
      CONTRACTING: 'CONTRACTING',
      CANCELED: 'CANCELED',
      CANCELLED: 'CANCELED',
    };
    return MAP[String(rawStatus || '').toUpperCase()] || null;
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

  // Sem API do provider, não há vocabulário de status bruto pra normalizar — evolução de status
  // é só por ação humana (ver comentário da classe).
  normalizeProviderStatus() {
    return null;
  }
}

module.exports = {
  verifyHmacSignature,
  SandboxFinancingProviderAdapter,
  ManualWorkflowFinancingProviderAdapter,
};
