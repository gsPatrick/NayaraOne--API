'use strict';

const { sanitizePayload } = require('../errors/sanitizeForError');
const { statusUnmapped } = require('./adapters.errors');

/** Métodos que TODO adapter concreto precisa sobrescrever (M9-D209 3.1). `redact` tem padrão seguro. */
const REQUIRED_METHODS = Object.freeze(['providerCode', 'capabilities', 'supportedVersions', 'healthCheck', 'classifyError', 'mapStatus']);

/**
 * IntegrationAdapter — o contrato base de todo fornecedor externo (M9-D209). O resto do sistema só conhece o Port; o SDK
 * ou a API HTTP do fornecedor fica escondida dentro do adapter. O adapter não conhece empresa, usuário nem banco: recebe
 * tudo em `ctx` (conexão sem segredo, política, tempos, cliente HTTP único e leitor de segredo) e em `request`.
 *
 * Cada port de domínio estende esta classe e declara `static domain` (um dos 14 do catálogo), `static portVersion` e
 * `static operations` (nome da capability -> { inputSchema, outputSchema }). Cada operação recebe `(ctx, request)` e devolve
 * `{ externalRequestId, externalResourceId, status, raw }`; `raw` jamais sai do módulo de integrações.
 */
class IntegrationAdapter {
  constructor(ctx = null) {
    this.ctx = ctx;
  }

  /** Código do catálogo (integration.providers.code). */
  providerCode() { throw new Error('providerCode() não implementado'); }

  /** Lista de capabilities (operações) suportadas, subconjunto das do domínio. */
  capabilities() { throw new Error('capabilities() não implementado'); }

  /** A capability é suportada por este fornecedor? O domínio pergunta antes de pedir e degrada de forma declarada quando não (M9-D221 3.3), nunca falha. */
  supports(capability) { return this.capabilities().includes(capability); }

  /** Versões da API do fornecedor suportadas. */
  supportedVersions() { throw new Error('supportedVersions() não implementado'); }

  /** { ok, latencyMs, detail, quota? }. Nunca deve lançar: falha vira ok:false (quem chama também protege). */
  async healthCheck(_ctx) { throw new Error('healthCheck() não implementado'); }

  /** { class: TRANSIENT|RATE_LIMIT|AUTH|VALIDATION|UNKNOWN, code, retryAfterMs? }: só o adapter conhece os códigos do fornecedor. */
  classifyError(_errOrResponse) { throw new Error('classifyError() não implementado'); }

  /** Status do fornecedor -> status interno normalizado; desconhecido devolve null (nunca presume). */
  mapStatus(_externalStatus) { throw new Error('mapStatus() não implementado'); }

  /** Hosts que o fornecedor pode receber (M9-D244 3.2): 'api.exemplo.com.br' ou '*.exemplo.com.br'. Vazio = nenhuma saída. */
  allowedHosts() { return []; }

  /**
   * A operação aceita chave de idempotência do chamador (cabeçalho ou campo do fornecedor)? Padrão: não (M9-D214 3.2 item 3). Com
   * `true`, o Dispatch Service entrega a chave estável em `meta.idempotencyKey` (3º argumento da operação) e repetir é seguro (M9-D216).
   */
  supportsIdempotency(_operation) { return false; }

  /**
   * A resposta da operação, com o id do recurso e o status final, basta como confirmação? Padrão: não (M9-D239 3.1: rede social SEM consulta
   * de status confirma pelo `externalPostId` da resposta). Com `true`, o worker confirma por `RESPONSE_ID` quando a resposta traz o id e um status final de sucesso.
   */
  confirmsOnResponse(_operation) { return false; }

  /**
   * Cota informada pelo fornecedor numa resposta ou erro (M9-D218 3.1): { limit, remaining, resetsAt } ou null. O padrão lê os cabeçalhos
   * X-RateLimit-Limit, -Remaining e -Reset (e Retry-After); o adapter sobrescreve quando a cota vem em outro lugar (campo do corpo).
   */
  extractQuota(responseOrError, now = new Date()) {
    return require('../dispatch/quota/quota.extract').extractQuotaFromHeaders(responseOrError && (responseOrError.headers ? responseOrError : responseOrError.raw), now);
  }

  /**
   * Verificador de assinatura dos webhooks do fornecedor (M9-D211 3.3): objeto { name, verify({ rawBody, headers, secret, now }) } escolhido entre os
   * prontos de webhooks/verifiers (hmacSha256Hex, hmacSha256Base64, hmacWithTimestamp) ou próprio. Padrão: nenhum, e a rota responde 501 (nunca aceita sem verificar).
   */
  webhookVerifier() { return null; }

  /**
   * Esquemas JSON (Ajv) dos eventos que o fornecedor envia (M9-D212 e M9-D213, INT-009): { '<tipo do evento>' ou '*': { '<versão da API>': esquema } }.
   * Padrão: null, e todo evento do fornecedor vai para a fila de erros (SCHEMA_INVALID): payload externo nunca é aceito sem esquema declarado.
   */
  webhookSchemas() { return null; }

  /** O evento do fornecedor traz sempre o tipo (corpo ou cabeçalho)? Padrão: sim, e a rota manda para a fila de erros o que vier sem tipo (M9-D213 3.3). */
  webhookRequiresEventType() { return true; }

  /** O fornecedor NÃO manda identificador do evento (M9-D213 3.1): o id é derivado de sha256(fornecedor:horário:hash do corpo). Padrão: não. */
  webhookDerivesEventId() { return false; }

  /** Tipos de conteúdo extras que o fornecedor usa nos webhooks, além dos aceitos pela empresa (ex.: 'application/x-www-form-urlencoded'). */
  webhookContentTypes() { return []; }

  /** Versão da API de um evento recebido (cabeçalho x-api-version ou campo api_version/apiVersion do corpo); null quando o evento não diz. */
  webhookApiVersion(payload, headers) {
    const h = headers && (headers['x-api-version'] || headers['X-Api-Version']);
    const doCorpo = payload && typeof payload === 'object' ? (payload.api_version || payload.apiVersion) : null;
    const v = h || doCorpo;
    return typeof v === 'string' && v.trim() ? v.trim().slice(0, 16) : null;
  }

  /** Ordem dos status internos (M9-D212 3.2 item 4): { PROCESSING: 2, PAID: 3 }. Evento com ordem menor que a já aplicada é guardado sem regredir o domínio. Padrão: sem ordem. */
  statusRank() { return {}; }

  /**
   * Evento do fornecedor -> evento interno normalizado (M9-D212 3.2 item 3): { eventType, resourceRef, externalStatus, idempotencyKey, data }.
   * `meta`: { eventType, externalEventId, apiVersion }. O padrão lê os nomes comuns; o adapter sobrescreve quando o formato do fornecedor é outro.
   */
  toInternalEvent(payload, meta = {}) {
    const p = payload && typeof payload === 'object' ? payload : {};
    const domain = String(this.constructor.domain || 'integration').toLowerCase();
    const tipo = String(meta.eventType || 'event').toLowerCase().replace(/[^a-z0-9.]+/g, '_');
    const texto = (v) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 160) : (typeof v === 'number' && Number.isFinite(v) ? String(v) : null));
    return {
      eventType: `integration.${domain}.${tipo}`,
      resourceRef: texto(p.resourceId ?? p.resource_id ?? p.externalResourceId ?? p.external_resource_id),
      externalStatus: texto(p.status),
      idempotencyKey: texto(p.idempotencyKey ?? p.idempotency_key),
      data: {},
    };
  }

  /** Cópia sem segredo nem dado pessoal, para log e erro. */
  redact(obj) {
    if (obj === null || obj === undefined) return obj;
    return sanitizePayload(obj).sanitized;
  }

  /** mapStatus que recusa o que não conhece: 502 INTEGRATION_STATUS_UNMAPPED. */
  normalizeStatus(externalStatus) {
    const interno = this.mapStatus(externalStatus);
    if (interno === null || interno === undefined) throw statusUnmapped();
    return interno;
  }
}

module.exports = { IntegrationAdapter, REQUIRED_METHODS };
