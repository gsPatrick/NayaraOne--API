'use strict';

// O contrato de integrações entra só pelo index.js do módulo (M9-D210 3.2 regra 2).
const { AiAdapter, classifyHttpError } = require('../../integrations');
const { capabilityUnsupported, AiProviderError } = require('./providers.errors');
const { normalizeProviderError } = require('./normalizeError');
const { costAmount } = require('./providers.cost');
const { modelProblems, modelSupports } = require('./providers.models');

const FINISH_REASONS = Object.freeze(['stop', 'length', 'tool_calls', 'safety']);

/**
 * AIProviderAdapter — a tomada comum entre o ERP e qualquer fornecedor de modelo (M9-D010). Estende o port AiAdapter (que
 * estende IntegrationAdapter, M9-D209): `capabilities()` devolve a LISTA de operações suportadas e `models()` o catálogo.
 *
 * Operações (recebem só o `request`; a conexão, o cliente HTTP único e o leitor de segredo estão em `this.ctx`):
 *   generate({ model, system, messages, tools?, responseSchema?, maxOutputTokens, temperature, timeoutMs, correlationId, idempotencyKey })
 *   embed({ model, inputs }) | transcribe({ model, fileRef, language }) | analyzeImage({ model, imageRef, prompt })
 * O que o adapter não declara em `capabilities()` cai aqui e lança, de forma SÍNCRONA, 501 AI_CAPABILITY_UNSUPPORTED. Falha de
 * fornecedor sai como AiProviderError (`failure()`); nada de HTTP fora do `ctx.http` (IntegrationHttpClient).
 */
class AIProviderAdapter extends AiAdapter {
  generate() { throw capabilityUnsupported('generate'); }

  embed() { throw capabilityUnsupported('embed'); }

  transcribe() { throw capabilityUnsupported('transcribe'); }

  analyzeImage() { throw capabilityUnsupported('analyzeImage'); }

  /** Catálogo de modelos: [{ model, classe, generate, embed, transcribe, vision, maxInputTokens, ... safetyTier }]. */
  models() { return []; }

  supportedVersions() { return ['v1']; }

  /** Adapter sem fornecedor externo (sandbox) vive sem conexão e só no laboratório; o real exige conexão ACTIVE do registro de integrações. */
  static get requiresConnection() { return true; }

  static get labOnly() { return false; }

  classifyError(errOrResponse) { return classifyHttpError(errOrResponse); }

  /** Fim de geração do fornecedor -> estado interno; o que não se conhece devolve null (nunca presume). */
  mapStatus(finishReason) {
    return ['stop', 'end_turn', 'length', 'max_tokens', 'tool_use', 'tool_calls', 'STOP', 'MAX_TOKENS'].includes(finishReason) ? 'COMPLETED' : null;
  }

  /** Erro normalizado de qualquer falha do fornecedor. */
  failure(err) { return normalizeProviderError(err, { providerCode: this.providerCode(), classify: (e) => this.classifyError(e) }); }

  /** Linha do catálogo do modelo pedido; modelo desconhecido é VALIDATION (nunca cai num modelo "parecido"). */
  modelEntry(name, operation) {
    const entry = this.models().find((m) => m.model === name);
    if (!entry) throw new AiProviderError('VALIDATION', { providerCode: this.providerCode(), upstreamCode: 'MODEL_UNKNOWN' });
    if (operation && !modelSupports(entry, operation)) throw capabilityUnsupported(operation);
    return entry;
  }

  /** Custo em reais com 6 casas pelo preço do catálogo. */
  costFor(entry, usage) {
    return costAmount(usage, { pricePerMTokIn: entry.pricePerMTokIn, pricePerMTokOut: entry.pricePerMTokOut });
  }

  /** Credencial no instante da chamada (SecretStore, D202): nunca guardada no adapter nem copiada para o request. */
  async apiKey(purpose = 'dispatch') {
    try {
      return (await this.ctx.secret(purpose)).value.reveal();
    } catch (err) {
      throw new AiProviderError('AUTH', { providerCode: this.providerCode(), status: 400, code: 'AI_PROVIDER_NOT_CONFIGURED', message: 'Informe a credencial do provedor antes de usá-lo.', upstreamCode: 'SECRET_UNAVAILABLE' });
    }
  }

  /** Confere o catálogo de modelos declarado (usado nos testes de contrato). */
  catalogProblems() { return this.models().flatMap((m) => modelProblems(m).map((c) => `${m && m.model}: ${c}`)); }
}

module.exports = { AIProviderAdapter, FINISH_REASONS };
