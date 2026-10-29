'use strict';

const { computePurchaseSuggestions } = require('./inventoryNay.service');

/** Risco de falta de estoque para o agente da Diretoria da camada de IA (M9-D035): itens em risco por nível, pelas mesmas regras do módulo de Estoque. Somente agregados. */
async function getStockRisks(tenant, transaction) {
  const { suggestions, windowDays } = await computePurchaseSuggestions(tenant, {}, transaction);
  const byLevel = { HIGH: 0, MEDIUM: 0, LOW: 0 };
  let stockout = 0;
  for (const s of suggestions) {
    byLevel[s.riskLevel] = (byLevel[s.riskLevel] || 0) + 1;
    if (s.payload.stockoutRisk) stockout += 1;
  }
  return {
    generatedAt: new Date().toISOString(), source: 'inventory.balances', windowDays, atRiskCount: suggestions.length, stockoutCount: stockout, byLevel,
  };
}

module.exports = { getStockRisks };
