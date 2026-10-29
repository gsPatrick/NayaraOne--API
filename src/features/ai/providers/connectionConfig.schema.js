'use strict';

const { CLASSES, RETENTIONS } = require('./providers.models');

const bool = { type: 'boolean' };
const nat = { type: 'integer', minimum: 0 };
const price = { type: ['number', 'string'] };

/**
 * Schema do config_json da conexão de um provedor de IA (M9-D011), gravado em integration.providers.config_schema pela
 * migration. Sem segredo aqui (o registro de integrações recusa). `data_retention` é o valor que a retenção da NAY lê
 * (providerRetentionCaps, M9-D028); `allowsConfidential` e `allowsRestricted` só mudam com ai:admin (connections.aiRules).
 * `models` é o catálogo da conta (preços e limites do contrato); os limites de tamanho se chamam `maxInput` e `maxOutput` aqui (o
 * registro recusa chave com "token" no nome, por parecer segredo) e viram maxInputTokens/maxOutputTokens em `models()`; `baseUrl` troca o endereço do fornecedor (proxy, laboratório).
 */
const MODEL_SCHEMA = {
  type: 'object',
  required: ['model', 'classe', 'generate', 'embed', 'transcribe', 'vision', 'maxInput', 'maxOutput', 'structuredOutput', 'toolUse', 'dataRetention', 'region', 'pricePerMTokIn', 'pricePerMTokOut', 'p95LatencyMs', 'safetyTier'],
  properties: {
    model: { type: 'string', minLength: 1, maxLength: 120 },
    classe: { type: 'string', enum: [...CLASSES] },
    generate: bool, embed: bool, transcribe: bool, vision: bool, structuredOutput: bool, toolUse: bool,
    maxInput: nat, maxOutput: nat, p95LatencyMs: nat,
    dataRetention: { type: 'string', enum: [...RETENTIONS] },
    region: { type: 'string', minLength: 1, maxLength: 32 },
    pricePerMTokIn: price, pricePerMTokOut: price,
    safetyTier: { type: 'integer', minimum: 1, maximum: 3 },
  },
  additionalProperties: false,
};

const AI_CONNECTION_CONFIG_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    region: { type: 'string', minLength: 1, maxLength: 32 },
    data_retention: { type: 'string', enum: [...RETENTIONS] },
    contract_ref: { type: 'string', maxLength: 160 },
    lab_only: bool,
    allowsConfidential: bool,
    allowsRestricted: bool,
    baseUrl: { type: 'string', maxLength: 300, pattern: '^https?://' },
    providerApiVersion: { type: 'string', maxLength: 32 },
    models: { type: 'array', items: MODEL_SCHEMA },
  },
  additionalProperties: false,
});

module.exports = { AI_CONNECTION_CONFIG_SCHEMA };
