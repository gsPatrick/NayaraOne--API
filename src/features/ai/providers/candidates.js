'use strict';

const { costMicros, microsToAmount } = require('./providers.cost');
const { modelSupports } = require('./providers.models');

const FREE = ['PUBLIC', 'INTERNAL'];
const KNOWN = [...FREE, 'CONFIDENTIAL', 'RESTRICTED'];

/** O provedor aceita receber dado dessa classificação? (mesma regra do portão da D027, lado do provedor; desconhecida = RESTRICTED). */
function acceptsClassification(classification, { policy, retention }) {
  const c = KNOWN.includes(classification) ? classification : 'RESTRICTED';
  if (FREE.includes(c)) return true;
  if (c === 'CONFIDENTIAL') return policy.allowsConfidential === true && Boolean(policy.contractRef);
  return policy.allowsRestricted === true && retention === 'NONE';
}

/** Política da chamada: lab_only fora de produção, classificação, retenções e regiões aceitas. */
function passesPolicy(entry, { politica, production }) {
  if (entry.policy.labOnly && production) return false;
  const retention = entry.policy.dataRetention || entry.model.dataRetention;
  const region = entry.policy.region || entry.model.region;
  if (!acceptsClassification(politica.classification || 'INTERNAL', { policy: entry.policy, retention })) return false;
  if (Array.isArray(politica.retentions) && politica.retentions.length && !politica.retentions.includes(retention)) return false;
  if (Array.isArray(politica.regions) && politica.regions.length && !politica.regions.includes(region)) return false;
  return true;
}

/**
 * Lista ordenada de candidatos (M9-D011). `entries`: [{ providerCode, policy, model, capabilities }]. Ordem do livro: (1) capability;
 * (2) política; (3) criticidade (CRITICAL exige safetyTier >= `criticalMinSafetyTier`); modelo acima do orçamento de latência sai;
 * (4) ordena pelo custo estimado do pedido, depois p95 e por fim pelo código. A decisão final é do ModelRouter (M9-D012).
 */
function rankCandidates(entries, { capabilities, criticidade, politica = {}, requestSize = {}, latencyBudgetMs }, { production, criticalMinSafetyTier }) {
  const exigidas = capabilities.length ? capabilities : ['generate'];
  const lista = entries
    .filter((e) => exigidas.every((cap) => e.capabilities.includes(cap) && modelSupports(e.model, cap)))
    .filter((e) => passesPolicy(e, { politica, production }))
    .filter((e) => String(criticidade || '').toUpperCase() !== 'CRITICAL' || e.model.safetyTier >= criticalMinSafetyTier)
    .filter((e) => !Number.isFinite(latencyBudgetMs) || e.model.p95LatencyMs <= latencyBudgetMs)
    .map((e) => {
      const micros = costMicros({ tokensIn: requestSize.tokensIn || 0, tokensOut: requestSize.tokensOut || 0, pricePerMTokIn: e.model.pricePerMTokIn, pricePerMTokOut: e.model.pricePerMTokOut });
      return {
        providerCode: e.providerCode,
        model: e.model.model,
        classe: e.model.classe,
        safetyTier: e.model.safetyTier,
        p95LatencyMs: e.model.p95LatencyMs,
        region: e.policy.region || e.model.region,
        dataRetention: e.policy.dataRetention || e.model.dataRetention,
        estimatedCostMicros: micros,
        estimatedCost: microsToAmount(micros),
      };
    });
  return lista.sort((a, b) => a.estimatedCostMicros - b.estimatedCostMicros || a.p95LatencyMs - b.p95LatencyMs || a.providerCode.localeCompare(b.providerCode) || a.model.localeCompare(b.model));
}

module.exports = { rankCandidates, passesPolicy, acceptsClassification };
