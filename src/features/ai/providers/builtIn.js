'use strict';

const { providerRegistry } = require('./ProviderRegistry');
const { SandboxAdapter } = require('./sandbox/SandboxAdapter');
const { AnthropicAdapter } = require('./anthropic/AnthropicAdapter');
const { OpenAIAdapter } = require('./openai/OpenAIAdapter');

/** Adapters de modelo que sobem com o servidor. Fornecedor novo = um arquivo de adapter + uma linha aqui + a linha do catálogo. */
const AI_BUILT_IN_ADAPTERS = Object.freeze([SandboxAdapter, AnthropicAdapter, OpenAIAdapter]);

/** Registra todos no ProviderRegistry (que registra no registro de integrações). Contrato inválido derruba o boot. */
function registerAiAdapters() {
  AI_BUILT_IN_ADAPTERS.forEach((A) => providerRegistry.register(A));
  return providerRegistry.list();
}

module.exports = { AI_BUILT_IN_ADAPTERS, registerAiAdapters };
