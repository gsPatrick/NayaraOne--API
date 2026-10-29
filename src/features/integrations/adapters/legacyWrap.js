'use strict';

const { classifyHttpError } = require('../registry/classifyHttpError');
const { hmacVerify } = require('./hmacVerify');
const { hmacSha256Hex } = require('../webhooks/verifiers/hmac');

const SANDBOX_HEALTH = async () => ({ ok: true, latencyMs: 0, detail: 'Sandbox local: não faz chamada externa.' });

/**
 * wrapLegacy — adapta um adapter que já existia (duck-typed, usado pelos módulos de negócio) ao contrato M9-D209 SEM mudar
 * o comportamento dele: o objeto antigo continua sendo o que executa; esta classe estende o port do domínio, declara o
 * código, as capabilities e as versões, e traduz cada operação `(ctx, request)` para a chamada antiga.
 * `ops`: capability -> async (legacy, request, self) => { externalRequestId?, externalResourceId?, status, raw? }.
 * `mapper`: status do fornecedor -> status interno (ou null).
 * `webhookHeader` (M9-D211): cabeçalho da assinatura HMAC-SHA256 dos adapters que declaram a capability verifyWebhook (padrão x-webhook-signature).
 * `idempotentOps` (M9-D240): operações em que a chave de idempotência do envio chega em `meta.idempotencyKey` (4º argumento de `ops`); `lookups`: consultas de
 * reconciliação (M9-D215) `findByIdempotencyKey` etc., como `async (legacy, request, self) => ({ found, status, externalResourceId })`.
 */
function wrapLegacy({ Port, className, code, versions = ['v1'], capabilities, makeLegacy, ops, mapper, health = SANDBOX_HEALTH, idempotentOps = [], lookups = {}, webhookHeader = 'x-webhook-signature', schemas = null, derivesEventId = false, toInternalEvent = null }) {
  const Adapter = class extends Port {
    providerCode() { return code; }

    capabilities() { return [...capabilities]; }

    supportedVersions() { return [...versions]; }

    async healthCheck(ctx) { return health(ctx, this); }

    classifyError(e) { return classifyHttpError(e); }

    mapStatus(externalStatus) { return mapper(String(externalStatus ?? '').toUpperCase()); }

    supportsIdempotency(operation) { return idempotentOps.includes(operation); }

    webhookVerifier() { return capabilities.includes('verifyWebhook') ? hmacSha256Hex({ header: webhookHeader }) : null; }

    /** Adapters antigos: os eventos dos módulos de negócio não trazem tipo. */
    webhookRequiresEventType() { return false; }

    /** Adapters antigos: o evento é um objeto com identificador (ou o esquema próprio do fornecedor, `schemas`); o formato fino é do módulo de negócio (alias do webhook antigo). */
    webhookSchemas() {
      if (!capabilities.includes('verifyWebhook')) return null;
      return schemas || { '*': Object.fromEntries(versions.map((v) => [v, { type: 'object', required: ['id'] }])) };
    }

    /** Fornecedor que não manda identificador do evento (M9-D213): o id é derivado do corpo. */
    webhookDerivesEventId() { return derivesEventId; }

    toInternalEvent(payload, meta) { return toInternalEvent ? toInternalEvent(payload, meta) : super.toInternalEvent(payload, meta); }

    async legacy(ctx) {
      if (!this.legacyInstance) this.legacyInstance = await makeLegacy(ctx);
      return this.legacyInstance;
    }

    /** O objeto antigo (interface original do módulo de negócio), criado na hora: o Correspondente continua falando com ele (M9-D240). */
    legacyAdapterSync() {
      if (!this.legacyInstance) this.legacyInstance = makeLegacy(this.ctx);
      return this.legacyInstance;
    }
  };
  Object.defineProperty(Adapter, 'name', { value: className });
  capabilities.forEach((cap) => {
    Adapter.prototype[cap] = async function operacao(ctx, request, meta) {
      const resposta = await ops[cap](await this.legacy(ctx), request, this, meta);
      return { externalRequestId: null, externalResourceId: null, ...resposta };
    };
  });
  Object.entries(lookups).forEach(([nome, fn]) => {
    Adapter.prototype[nome] = async function consulta(ctx, request) { return fn(await this.legacy(ctx), request, this); };
  });
  return Adapter;
}

/** Mapa de status -> função de mapeamento (chave em maiúsculas; o que não está no mapa devolve null). */
const mapFrom = (tabela) => (s) => (Object.prototype.hasOwnProperty.call(tabela, s) ? tabela[s] : null);

/** Operação sem ciclo de vida de status: concluída. */
const COMPLETED = 'COMPLETED';
const verifyOp = (legacyVerify) => async (legacy, req) => ({ status: legacyVerify(legacy, req) ? 'VALID' : 'INVALID' });

module.exports = { wrapLegacy, mapFrom, COMPLETED, verifyOp, hmacVerify };
