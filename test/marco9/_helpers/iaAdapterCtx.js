'use strict';

// ctx de adapter real SEM banco (M9-D010): conexão com o endereço do servidor falso, cliente HTTP único e segredo em memória.
const crypto = require('node:crypto');
const { IntegrationHttpClient } = require('../../../src/features/integrations/http/IntegrationHttpClient');
const { SecretValue } = require('../../../src/features/integrations/secrets/SecretValue');

const SEGREDO = 'sk-teste-nao-vaza-0123456789';

/** Linha do catálogo de modelos da conexão (preços em reais por milhão de tokens). */
const modelo = (over = {}) => ({
  model: 'm-gen', classe: 'SMALL', generate: true, embed: false, transcribe: false, vision: false, structuredOutput: true, toolUse: true,
  maxInputTokens: 100000, maxOutputTokens: 2048, dataRetention: '30D', region: 'US', pricePerMTokIn: 5, pricePerMTokOut: 15,
  p95LatencyMs: 800, safetyTier: 2, ...over,
});
const MODELO_EMBED = () => modelo({ model: 'm-emb', classe: 'EMBEDDING', generate: false, embed: true, structuredOutput: false, toolUse: false, maxOutputTokens: 0, pricePerMTokIn: 1, pricePerMTokOut: 0 });

/** Linha do catálogo -> linha de config_json.models (o registro recusa chave com "token" no nome). */
const paraConfig = (m) => { const { maxInputTokens, maxOutputTokens, ...resto } = m; return { ...resto, maxInput: maxInputTokens, maxOutput: maxOutputTokens }; };

/** Cada chamada cria uma conexão nova (o circuito do cliente é por conexão: um teste não abre o circuito do outro). */
function realCtx(providerCode, baseUrl, { models = [modelo(), MODELO_EMBED()], secret = SEGREDO, timeouts = { readMs: 2000, writeMs: 2000 } } = {}) {
  const id = crypto.randomUUID();
  return Object.freeze({
    connection: Object.freeze({ id, providerCode, environment: 'SANDBOX', apiVersion: null, config: { baseUrl, models: models.map(paraConfig) } }),
    policy: {},
    timeouts,
    http: new IntegrationHttpClient({ providerCode, connectionId: id, timeouts }),
    secret: async () => {
      if (secret === null) throw new Error('segredo ausente');
      return { value: new SecretValue(secret) };
    },
  });
}

module.exports = { realCtx, paraConfig, modelo, MODELO_EMBED, SEGREDO };
