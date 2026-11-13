'use strict';

// M9-D034 — imóveis compatíveis com a oportunidade, já calculados pelo Radar (perfil de busca da oportunidade). A NAY só apresenta: o
// Radar decide quem combina e a ordem; aqui se aplica o limite `ia.comercial.radar_max_imoveis` e se conta o que ficou de fora.
const radarService = require('../../../radar/radar.service');
const { explainMatch } = require('../../../radar/radarMatching.service');
const { PropertyRadar } = require('../../../../models');
const { findOpportunity } = require('./comercial.data');

const LABELS = Object.freeze({
  propertyType: 'tipo do imóvel', city: 'cidade', state: 'estado', area: 'metragem', priceRange: 'faixa de preço', offerType: 'tipo de oferta',
});

const reasonOf = (explanation) => {
  const ok = Object.entries(explanation.criteria || {}).filter(([, v]) => v.matched).map(([k]) => LABELS[k] || k);
  return ok.length ? `Atende: ${ok.join(', ')}.` : 'Combina com o perfil de busca do Radar.';
};

/**
 * `{ opportunityId, radars, total, shown, hasMore, extra, matches: [{ propertyId, radarId, score, title, reason }] }`, ordenados por
 * pontuação do Radar (do maior ao menor; empate mantém a ordem do Radar, mais recente primeiro) e cortados em `limit`.
 */
async function listRadarMatches(opportunityId, transaction, { limit, ownerScope = null }) {
  const opportunity = await findOpportunity(opportunityId, transaction, ownerScope);
  const radars = await PropertyRadar.findAll({ where: { opportunityId: opportunity.id, status: 'ACTIVE' }, order: [['created_at', 'ASC']], transaction });
  const all = [];
  for (const radar of radars) {
    for (const property of await radarService.getRadarMatches(radar.id, transaction)) {
      const explanation = explainMatch(radar, property);
      all.push({ propertyId: property.id, radarId: radar.id, score: explanation.score, title: property.title || null, city: property.city || null, reason: reasonOf(explanation) });
    }
  }
  const seen = new Set();
  const unique = all.filter((m) => (seen.has(m.propertyId) ? false : seen.add(m.propertyId)));
  const sorted = unique.map((m, i) => ({ m, i })).sort((a, b) => (b.m.score - a.m.score) || (a.i - b.i)).map((x) => x.m);
  const matches = sorted.slice(0, limit);
  return { opportunityId: opportunity.id, radars: radars.length, total: sorted.length, shown: matches.length, hasMore: sorted.length > matches.length, extra: sorted.length - matches.length, matches };
}

module.exports = { listRadarMatches };
