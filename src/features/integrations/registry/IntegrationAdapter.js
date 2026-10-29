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
