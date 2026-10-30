'use strict';

const { providerRegistry } = require('../../../ai/providers/ProviderRegistry');
const { costMicros } = require('../../../ai/providers/providers.cost');
const { recordUsage, consolidateClosedHours } = require('../accrual.service');
const { PLATFORM_DOMAIN } = require('../finops.constants');

/** Preço do modelo na tabela do registry do provider (R$ por milhão de tokens), ou null se o provider ou o modelo não existem. */
function modelPrice(registry, providerCode, modelCode) {
  const Adapter = registry.classOf(providerCode);
  if (!Adapter) return null;
  return new Adapter(null).models().find((m) => m.model === modelCode) || null;
}

/**
 * Coletor de IA (M9-D860 §3.2): cada chamada soma, na hora, os tokens de entrada e saída, o modelo e o custo pela tabela de preços do registry do provider
 * (frações de centavo preservadas: R$ 1e-6 = 0,0001 centavo). Provider ou modelo desconhecido NÃO grava (nunca inventa preço): devolve { recorded: false }.
 */
async function recordAiCall(tenant, { providerCode, modelCode, tokensIn = 0, tokensOut = 0, domain = PLATFORM_DOMAIN, at = new Date(), registry = providerRegistry }, transaction) {
  const model = modelPrice(registry, providerCode, modelCode);
  if (!model) return { recorded: false, reason: 'MODEL_PRICE_UNKNOWN' };
  const micros = costMicros({ tokensIn, tokensOut, pricePerMTokIn: model.pricePerMTokIn, pricePerMTokOut: model.pricePerMTokOut });
  await recordUsage(tenant, {
    category: 'AI', service: `llm:${modelCode}`, domain, quantity: tokensIn + tokensOut, unit: 'tokens', costScaled: BigInt(micros) * 100n, tokensIn, tokensOut, at,
  }, transaction);
  return { recorded: true };
}

/** Fecha as horas encerradas da IA: uma linha ESTIMATED inteira por hora e modelo. */
const collectAi = (tenant, now, transaction) => consolidateClosedHours(tenant, now, ['AI'], transaction);

module.exports = { recordAiCall, collectAi, modelPrice };
