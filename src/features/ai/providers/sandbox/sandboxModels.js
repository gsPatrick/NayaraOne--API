'use strict';

const { SANDBOX_PRICE_IN_MICROS, SANDBOX_PRICE_OUT_MICROS } = require('./sandboxGenerate');

const SANDBOX_CODE = 'ai-sandbox';
const SANDBOX_DIMENSIONS = 64;

const base = {
  generate: false, embed: false, transcribe: false, vision: false, structuredOutput: false, toolUse: false,
  maxInputTokens: 100000, maxOutputTokens: 4096, dataRetention: 'NONE', region: 'BR',
  pricePerMTokIn: SANDBOX_PRICE_IN_MICROS, pricePerMTokOut: SANDBOX_PRICE_OUT_MICROS, p95LatencyMs: 100, safetyTier: 2,
};

/** Catálogo do sandbox: preço de teste fixo (2 e 6 micro-reais por token = R$ 2,00 e R$ 6,00 por milhão no pequeno), nada sai da máquina. */
const SANDBOX_MODELS = Object.freeze([
  Object.freeze({ ...base, model: 'sandbox-1', classe: 'SMALL', generate: true, structuredOutput: true, toolUse: true }),
  // Modelo avançado do laboratório (M9-D012): mesma resposta determinística, preço cinco vezes maior e p95 maior, para o roteador provar os dois caminhos.
  Object.freeze({
    ...base, model: 'sandbox-advanced-1', classe: 'ADVANCED', generate: true, structuredOutput: true, toolUse: true,
    pricePerMTokIn: SANDBOX_PRICE_IN_MICROS * 5, pricePerMTokOut: SANDBOX_PRICE_OUT_MICROS * 5, p95LatencyMs: 400, safetyTier: 3,
  }),
  Object.freeze({ ...base, model: 'sandbox-embed-1', classe: 'EMBEDDING', embed: true, maxOutputTokens: 0, pricePerMTokOut: 0 }),
  Object.freeze({ ...base, model: 'sandbox-media-1', classe: 'SMALL', transcribe: true, vision: true }),
]);

module.exports = { SANDBOX_CODE, SANDBOX_DIMENSIONS, SANDBOX_MODELS };
