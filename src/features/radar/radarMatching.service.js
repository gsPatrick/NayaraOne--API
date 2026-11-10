'use strict';

const { Op } = require('sequelize');
const { Property, PropertyOffer, PropertyRadar, PropertyAddress } = require('../../models');
const { normalizeCriteria } = require('./radarCriteria');
const { evaluateExtras, scoreOf } = require('./radarScoring');

/**
 * Critérios suportados em `criteriaJson` (todos opcionais — critério ausente não filtra):
 *   - propertyType: "RESIDENTIAL"|"COMMERCIAL"|"LAND"|"RURAL"
 *   - offerType: "SALE"|"RENT" (obrigatório para o matching considerar preço/oferta)
 *   - minPrice / maxPrice: faixa de preço da offer ATIVA do tipo acima
 *   - city / state: localização exata (comparação case-insensitive)
 *   - minAreaM2 / maxAreaM2: faixa de área total do imóvel
 *
 * matchRadarToProperties — matching 100% determinístico: WHERE clauses diretas via
 * Sequelize/SQL, sem heurística difusa nem scoring. Ordem de prioridade do resultado:
 *   1. Offer mais recente (created_at DESC) primeiro.
 * Retorna todas as properties com offer ACTIVE do offerType do radar que atendem
 * simultaneamente a TODOS os critérios preenchidos.
 */
async function matchRadarToProperties(radar, transaction, options = {}) {
  // Obrigatórios (§13): chaves planas + `required`. Preferências/flexíveis/exclusões são avaliados depois, em memória.
  const criteria = normalizeCriteria(radar.criteriaJson).required;

  const offerWhere = { status: 'ACTIVE' };
  if (options.propertyId) {
    // Usado por matchNewPropertyToRadars (CRMX-007) para restringir a varredura a UM imóvel
    // específico recém-publicado, em vez de rodar a query completa do radar contra toda a
    // base — mesma lógica de critérios, só filtrada por property.id.
  }
  if (criteria.offerType) offerWhere.offerType = String(criteria.offerType).toUpperCase();
  if (criteria.minPrice !== undefined && criteria.minPrice !== null) {
    offerWhere.askingPrice = { ...(offerWhere.askingPrice || {}), [Op.gte]: criteria.minPrice };
  }
  if (criteria.maxPrice !== undefined && criteria.maxPrice !== null) {
    offerWhere.askingPrice = { ...(offerWhere.askingPrice || {}), [Op.lte]: criteria.maxPrice };
  }

  const propertyWhere = {};
  if (options.propertyId) propertyWhere.id = options.propertyId;
  if (criteria.propertyType) propertyWhere.propertyType = String(criteria.propertyType).toUpperCase();
  if (criteria.city) propertyWhere.city = { [Op.iLike]: criteria.city };
  if (criteria.state) propertyWhere.state = { [Op.iLike]: criteria.state };
  if (criteria.minAreaM2 !== undefined && criteria.minAreaM2 !== null) {
    propertyWhere.areaTotalM2 = { ...(propertyWhere.areaTotalM2 || {}), [Op.gte]: criteria.minAreaM2 };
  }
  if (criteria.maxAreaM2 !== undefined && criteria.maxAreaM2 !== null) {
    propertyWhere.areaTotalM2 = { ...(propertyWhere.areaTotalM2 || {}), [Op.lte]: criteria.maxAreaM2 };
  }

  const found = await Property.findAll({
    where: propertyWhere,
    include: [
      {
        model: PropertyOffer,
        as: 'offers',
        where: offerWhere,
        required: true,
      },
      // Bairro da preferência NEIGHBORHOOD vem do endereço do imóvel (real_estate.property_addresses).
      { model: PropertyAddress, as: 'address', required: false },
    ],
    order: [[{ model: PropertyOffer, as: 'offers' }, 'created_at', 'DESC']],
    transaction,
  });

  // Exclusão que bate tira o imóvel; os que ficam saem ordenados pelo score (empate mantém a ordem acima) e levam a explicação.
  return found
    .map((property, index) => ({ property, index, explanation: explainMatch(radar, property) }))
    .filter((m) => m.explanation.matched)
    .sort((a, b) => (b.explanation.score - a.explanation.score) || (a.index - b.index))
    .map(({ property, explanation }) => {
      property.setDataValue('radarMatch', explanation);
      return property;
    });
}

/**
 * M3-15 — EXPLICAÇÃO do match do Radar ("score/critérios").
 *
 * O matching acima continua EXATAMENTE como estava: 100% determinístico, booleano, resolvido
 * em SQL. Esta função NÃO o altera nem o substitui — ela roda ao lado, em memória, sobre um
 * imóvel JÁ CARREGADO, e responde a pergunta que o corretor faz na tela: "por que este imóvel
 * (não) apareceu pra este cliente?".
 *
 * Pontuação (livro §13 + Guia §9 "Radar scoring", radarScoring.js): cada obrigatório entra com category REQUIRED; preferências,
 * flexíveis (com peso, padrão 1) e exclusões entram com a sua categoria. Obrigatório que falhou ou exclusão que bateu ->
 * matched=false e score 0 (reasons REQUIRED_FAILED/EXCLUDED); senão score = pesos atendidos / pesos totais (1 sem preferências).
 *
 * Recebe `property` com as suas `offers` já carregadas (include as: 'offers'), ou um array
 * de offers explícito em `options.offers`.
 *
 * Retorno:
 *   {
 *     propertyId,
 *     matched: boolean,           // obrigatórios todos atendidos e nenhuma exclusão aplicada
 *     score: 0..1,                // Guia §9 (acima)
 *     requiredScore: 0..1,        // obrigatórios atendidos / obrigatórios avaliados
 *     reasons: [...],             // REQUIRED_FAILED/EXCLUDED, ou os códigos de preferência atendidos
 *     matchedCount, totalCriteria,
 *     criteria: { propertyType: { category: 'REQUIRED', matched: true }, 'preference:MIN_BEDROOMS': { category: 'PREFERENCE', weight: 2, matched: false, reason }, ... }
 *   }
 */
function explainMatch(radar, property, options = {}) {
  const normalized = normalizeCriteria(radar && radar.criteriaJson);
  const criteria = normalized.required;
  const offers = options.offers || property.offers || [];
  const activeOffers = offers.filter((offer) => offer.status === 'ACTIVE');
  const result = {};

  const add = (key, matched, reason) => {
    result[key] = reason === undefined ? { category: 'REQUIRED', matched } : { category: 'REQUIRED', matched, reason };
  };

  if (criteria.propertyType) {
    const expected = String(criteria.propertyType).toUpperCase();
    const actual = String(property.propertyType || '').toUpperCase();
    add(
      'propertyType',
      actual === expected,
      actual === expected ? undefined : `Tipo do imóvel é "${actual || '—'}", o radar procura "${expected}".`
    );
  }

  if (criteria.city) {
    const ok = String(property.city || '').toLowerCase() === String(criteria.city).toLowerCase();
    add('city', ok, ok ? undefined : `Cidade é "${property.city || '—'}", o radar procura "${criteria.city}".`);
  }

  if (criteria.state) {
    const ok = String(property.state || '').toLowerCase() === String(criteria.state).toLowerCase();
    add('state', ok, ok ? undefined : `Estado é "${property.state || '—'}", o radar procura "${criteria.state}".`);
  }

  const hasAreaCriteria =
    (criteria.minAreaM2 !== undefined && criteria.minAreaM2 !== null) ||
    (criteria.maxAreaM2 !== undefined && criteria.maxAreaM2 !== null);
  if (hasAreaCriteria) {
    const area = property.areaTotalM2 === null || property.areaTotalM2 === undefined ? null : Number(property.areaTotalM2);
    if (area === null) {
      add('areaRange', false, 'Imóvel sem área total cadastrada.');
    } else if (criteria.minAreaM2 !== undefined && criteria.minAreaM2 !== null && area < Number(criteria.minAreaM2)) {
      add('areaRange', false, `Área de ${area} m² é menor que o mínimo de ${criteria.minAreaM2} m².`);
    } else if (criteria.maxAreaM2 !== undefined && criteria.maxAreaM2 !== null && area > Number(criteria.maxAreaM2)) {
      add('areaRange', false, `Área de ${area} m² é maior que o máximo de ${criteria.maxAreaM2} m².`);
    } else {
      add('areaRange', true);
    }
  }

  // Oferta ativa: sempre avaliada — o matching só considera imóveis com offer ACTIVE.
  let candidateOffers = activeOffers;
  add(
    'activeOffer',
    activeOffers.length > 0,
    activeOffers.length > 0 ? undefined : 'Imóvel não tem nenhuma oferta ATIVA.'
  );

  if (criteria.offerType) {
    const expected = String(criteria.offerType).toUpperCase();
    const ofType = activeOffers.filter((offer) => String(offer.offerType || '').toUpperCase() === expected);
    add(
      'offerType',
      ofType.length > 0,
      ofType.length > 0 ? undefined : `Imóvel não tem oferta ATIVA do tipo "${expected}".`
    );
    candidateOffers = ofType;
  }

  const hasPriceCriteria =
    (criteria.minPrice !== undefined && criteria.minPrice !== null) ||
    (criteria.maxPrice !== undefined && criteria.maxPrice !== null);
  if (hasPriceCriteria) {
    if (candidateOffers.length === 0) {
      add('priceRange', false, 'Sem oferta ativa elegível para comparar o preço.');
    } else {
      const prices = candidateOffers.map((offer) => Number(offer.askingPrice));
      const withinRange = prices.filter((price) => {
        if (criteria.minPrice !== undefined && criteria.minPrice !== null && price < Number(criteria.minPrice)) return false;
        if (criteria.maxPrice !== undefined && criteria.maxPrice !== null && price > Number(criteria.maxPrice)) return false;
        return true;
      });
      if (withinRange.length > 0) {
        add('priceRange', true);
      } else {
        const price = prices[0];
        const tooHigh = criteria.maxPrice !== undefined && criteria.maxPrice !== null && price > Number(criteria.maxPrice);
        add(
          'priceRange',
          false,
          tooHigh
            ? `Acima do máximo: preço ${price} > ${criteria.maxPrice}.`
            : `Abaixo do mínimo: preço ${price} < ${criteria.minPrice}.`
        );
      }
    }
  }

  const requiredKeys = Object.keys(result);
  const requiredMatched = requiredKeys.filter((key) => result[key].matched).length;
  for (const [key, entry] of evaluateExtras(normalized, property)) result[key] = entry;

  const keys = Object.keys(result);
  const matchedCount = keys.filter((key) => result[key].matched).length;
  const scored = scoreOf(result);

  return {
    propertyId: property.id,
    matched: scored.matched,
    matchedCount,
    totalCriteria: keys.length,
    score: scored.score,
    requiredScore: requiredKeys.length === 0 ? 1 : Number((requiredMatched / requiredKeys.length).toFixed(4)),
    reasons: scored.reasons,
    criteria: result,
  };
}

/**
 * M3-22 — CRMX-007 ("Radar automático": "Novo imóvel ou novo cliente pode disparar matching
 * por eventos"). Até aqui o matching só rodava (a) sob demanda, quando alguém abria
 * `GET /radar/:id/matches`, ou (b) periodicamente, via radarMatchingJob.js — um imóvel novo
 * só era descoberto pelos radares existentes na próxima rodada do job (minutos/horas depois),
 * nunca no instante em que a oferta é publicada. Esta função fecha essa lacuna: dado um
 * imóvel recém-ativado (chamada por propertyOffers.service.js ao criar/ativar uma offer),
 * varre todos os PropertyRadar ACTIVE do mesmo tenant e devolve os que batem com ELE
 * especificamente — reaproveitando exatamente a mesma lógica/critérios de
 * matchRadarToProperties (via options.propertyId), não uma heurística paralela.
 */
async function matchNewPropertyToRadarsDetailed(property, transaction) {
  const radars = await PropertyRadar.findAll(
    { where: { groupId: property.groupId, companyId: property.companyId, status: 'ACTIVE' }, transaction }
  );
  const out = [];
  for (const radar of radars) {
    const [matched] = await matchRadarToProperties(radar, transaction, { propertyId: property.id });
    if (matched) out.push({ radar, property: matched });
  }
  return out;
}

async function matchNewPropertyToRadars(property, transaction) {
  return (await matchNewPropertyToRadarsDetailed(property, transaction)).map((m) => m.radar);
}

module.exports = { matchRadarToProperties, matchNewPropertyToRadars, matchNewPropertyToRadarsDetailed, explainMatch };
