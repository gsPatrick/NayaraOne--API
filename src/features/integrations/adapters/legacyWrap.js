'use strict';

const { classifyHttpError } = require('../registry/classifyHttpError');
const { hmacVerify } = require('./hmacVerify');

const SANDBOX_HEALTH = async () => ({ ok: true, latencyMs: 0, detail: 'Sandbox local: não faz chamada externa.' });

/**
 * wrapLegacy — adapta um adapter que já existia (duck-typed, usado pelos módulos de negócio) ao contrato M9-D209 SEM mudar
 * o comportamento dele: o objeto antigo continua sendo o que executa; esta classe estende o port do domínio, declara o
 * código, as capabilities e as versões, e traduz cada operação `(ctx, request)` para a chamada antiga.
 * `ops`: capability -> async (legacy, request, self) => { externalRequestId?, externalResourceId?, status, raw? }.
 * `mapper`: status do fornecedor -> status interno (ou null).
 */
function wrapLegacy({ Port, className, code, versions = ['v1'], capabilities, makeLegacy, ops, mapper, health = SANDBOX_HEALTH }) {
  const Adapter = class extends Port {
    providerCode() { return code; }

    capabilities() { return [...capabilities]; }

    supportedVersions() { return [...versions]; }

    async healthCheck(ctx) { return health(ctx, this); }

    classifyError(e) { return classifyHttpError(e); }

    mapStatus(externalStatus) { return mapper(String(externalStatus ?? '').toUpperCase()); }

    async legacy(ctx) {
      if (!this.legacyInstance) this.legacyInstance = await makeLegacy(ctx);
      return this.legacyInstance;
    }
  };
  Object.defineProperty(Adapter, 'name', { value: className });
  capabilities.forEach((cap) => {
    Adapter.prototype[cap] = async function operacao(ctx, request) {
      const resposta = await ops[cap](await this.legacy(ctx), request, this);
      return { externalRequestId: null, externalResourceId: null, ...resposta };
    };
  });
  return Adapter;
}

/** Mapa de status -> função de mapeamento (chave em maiúsculas; o que não está no mapa devolve null). */
const mapFrom = (tabela) => (s) => (Object.prototype.hasOwnProperty.call(tabela, s) ? tabela[s] : null);

/** Operação sem ciclo de vida de status: concluída. */
const COMPLETED = 'COMPLETED';
const verifyOp = (legacyVerify) => async (legacy, req) => ({ status: legacyVerify(legacy, req) ? 'VALID' : 'INVALID' });

module.exports = { wrapLegacy, mapFrom, COMPLETED, verifyOp, hmacVerify };
