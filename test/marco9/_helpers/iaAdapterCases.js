'use strict';

const { SandboxAdapter } = require('../../../src/features/ai/providers/sandbox/SandboxAdapter');
const { AnthropicAdapter } = require('../../../src/features/ai/providers/anthropic/AnthropicAdapter');
const { OpenAIAdapter } = require('../../../src/features/ai/providers/openai/OpenAIAdapter');
const { realCtx } = require('./iaAdapterCtx');

const HTTP = { AUTH: 401, VALIDATION: 400, RATE_LIMIT: 429, UNAVAILABLE: 503 };

/** Os adapters que passam pelo contrato: sandbox e os dois reais (contra o servidor falso em `baseUrl`). */
function casosDeContrato(baseUrl) {
  return [
    { name: 'ai-sandbox', make: () => new SandboxAdapter(null), genModel: 'sandbox-1', embedModel: 'sandbox-embed-1', marker: (k) => `[[FALHA:${k}]]`, slow: (ms) => `[[LENTO:${ms}]]` },
    { name: 'anthropic', make: () => new AnthropicAdapter(realCtx('anthropic', baseUrl)), genModel: 'm-gen', embedModel: null, marker: (k) => `[[HTTP:${HTTP[k]}]]`, slow: (ms) => `[[SLEEP:${ms}]]` },
    { name: 'openai', make: () => new OpenAIAdapter(realCtx('openai', baseUrl)), genModel: 'm-gen', embedModel: 'm-emb', marker: (k) => `[[HTTP:${HTTP[k]}]]`, slow: (ms) => `[[SLEEP:${ms}]]` },
  ];
}

module.exports = { casosDeContrato, HTTP };
