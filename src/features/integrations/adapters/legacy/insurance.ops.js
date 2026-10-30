'use strict';

const { mapFrom, COMPLETED, verifyOp, hmacVerify } = require('../legacyWrap');
const { SCHEMA_EVENTO, toInternalEvent } = require('./insurance.event');

/** Status do fornecedor de seguro -> status interno (M9-D238). Desconhecido volta null e vira erro de integração (nunca presume). */
const STATUS = mapFrom({
  ACTIVE: 'ACTIVE', ISSUED: 'ISSUED', QUOTED: 'QUOTED', PENDING: 'PENDING', UNDER_REVIEW: 'UNDER_REVIEW', APPROVED: 'APPROVED', DENIED: 'DENIED', SETTLED: 'SETTLED', EXPIRED: 'EXPIRED', CANCELED: 'CANCELED', CANCELLED: 'CANCELED', COMPLETED,
});

/** Sem webhook (fluxo manual e Junto Seguros) e com webhook (as demais: o status da apólice chega pela caixa de entrada). */
const CAPABILITIES = Object.freeze(['quote', 'propose', 'getPolicy', 'getStatus', 'submitClaim']);
const CAPABILITIES_WEBHOOK = Object.freeze([...CAPABILITIES, 'verifyWebhook']);

/**
 * Pedido do domínio -> pedido do objeto antigo. O módulo de Compras manda o que o mapper `insurance.quote`/`insurance.propose` deixa passar; `providerRequest` leva o corpo
 * específico da seguradora (campos que só o adapter dela entende, como a Yelum). Sem ele, o adapter recebe só o valor segurado.
 */
const quoteRequestOf = (req) => req.providerRequest || { ...req, estimatedValue: req.estimatedValue ?? req.insuredAmount };
const proposeRequestOf = (req, meta) => ({ ...(req.providerRequest || req), idempotencyKey: (meta && meta.idempotencyKey) || req.idempotencyKey });

/**
 * Operações do port InsuranceAdapter sobre o objeto antigo (quote, issuePolicy, getPolicyStatus). `quote` e `policy` na resposta levam o que a regra de negócio precisa
 * (prêmio, cobertura, número da apólice); `raw` é a resposta completa da seguradora e nunca sai do módulo de integrações (o Compras a lê pelo observador do worker).
 */
const OPS = Object.freeze({
  verifyWebhook: verifyOp((l, req) => hmacVerify(req.rawBody, req.headers, req.secret)),
  quote: async (l, req) => {
    const r = await l.quote(quoteRequestOf(req));
    return { externalResourceId: r.externalId, status: COMPLETED, quote: { premiumAmount: r.premiumAmount, coverageSummary: r.coverageSummary }, raw: r };
  },
  propose: async (l, req, self, meta) => {
    const r = await l.issuePolicy(proposeRequestOf(req, meta));
    return { externalResourceId: r.externalId, status: self.normalizeStatus(r.status), policy: { policyNumber: r.policyNumber || null, status: r.status }, raw: r };
  },
  getPolicy: async (l, req, self) => {
    const r = await l.getPolicyStatus(req.externalResourceId);
    return { externalResourceId: r.externalId ?? req.externalResourceId, status: self.normalizeStatus(r.status), policy: { policyNumber: r.policyNumber || null, status: r.status }, raw: r.raw };
  },
  getStatus: async (l, req, self) => {
    const r = await l.getPolicyStatus(req.externalResourceId);
    return { externalResourceId: r.externalId ?? req.externalResourceId, status: self.normalizeStatus(r.status), raw: r.raw };
  },
  submitClaim: async (l, req, self, meta) => {
    const r = await l.submitClaim({ idempotencyKey: (meta && meta.idempotencyKey) || req.idempotencyKey, externalPolicyNumber: req.externalPolicyNumber, description: req.description, claimAmount: req.claimAmount });
    return { externalResourceId: r.externalId, status: self.normalizeStatus(r.status), raw: r };
  },
});

/** Esquema e evento normalizado do webhook de status da apólice (iguais para todas as seguradoras que o têm). */
const WEBHOOK = Object.freeze({ schemas: { '*': { v1: SCHEMA_EVENTO } }, derivesEventId: false, toInternalEvent });

/**
 * As seguradoras reais (Porto Seguro e Yelum) não oferecem consulta por chave de idempotência: a pergunta "essa proposta/esse sinistro existe?" não tem resposta conclusiva, então o envio
 * incerto vai à revisão humana em vez de reenviar às cegas (a reconciliação trata `INTEGRATION_LOOKUP_UNSUPPORTED` como "sem resposta conclusiva", como no Santander).
 */
const semConsultaPorChave = async () => { throw Object.assign(new Error('A seguradora não oferece consulta por chave de idempotência.'), { code: 'INTEGRATION_LOOKUP_UNSUPPORTED' }); };

module.exports = { semConsultaPorChave, STATUS, CAPABILITIES, CAPABILITIES_WEBHOOK, OPS, WEBHOOK, quoteRequestOf, proposeRequestOf };
