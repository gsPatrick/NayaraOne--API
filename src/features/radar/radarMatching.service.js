'use strict';

const { Op } = require('sequelize');
const { Property, PropertyOffer } = require('../../models');

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
async function matchRadarToProperties(radar, transaction) {
  const criteria = radar.criteriaJson || {};

  const offerWhere = { status: 'ACTIVE' };
  if (criteria.offerType) offerWhere.offerType = String(criteria.offerType).toUpperCase();
  if (criteria.minPrice !== undefined && criteria.minPrice !== null) {
    offerWhere.askingPrice = { ...(offerWhere.askingPrice || {}), [Op.gte]: criteria.minPrice };
  }
  if (criteria.maxPrice !== undefined && criteria.maxPrice !== null) {
    offerWhere.askingPrice = { ...(offerWhere.askingPrice || {}), [Op.lte]: criteria.maxPrice };
  }

  const propertyWhere = {};
  if (criteria.propertyType) propertyWhere.propertyType = String(criteria.propertyType).toUpperCase();
  if (criteria.city) propertyWhere.city = { [Op.iLike]: criteria.city };
  if (criteria.state) propertyWhere.state = { [Op.iLike]: criteria.state };
  if (criteria.minAreaM2 !== undefined && criteria.minAreaM2 !== null) {
    propertyWhere.areaTotalM2 = { ...(propertyWhere.areaTotalM2 || {}), [Op.gte]: criteria.minAreaM2 };
  }
  if (criteria.maxAreaM2 !== undefined && criteria.maxAreaM2 !== null) {
    propertyWhere.areaTotalM2 = { ...(propertyWhere.areaTotalM2 || {}), [Op.lte]: criteria.maxAreaM2 };
  }

  return Property.findAll({
    where: propertyWhere,
    include: [
      {
        model: PropertyOffer,
        as: 'offers',
        where: offerWhere,
        required: true,
      },
    ],
    order: [[{ model: PropertyOffer, as: 'offers' }, 'created_at', 'DESC']],
    transaction,
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
 * DECISÃO DE ENGENHARIA DOCUMENTADA: não inventamos um "score" ponderado com pesos
 * arbitrários. O matching do sistema é booleano (todos os critérios preenchidos precisam
 * bater), então o número honesto que dá para mostrar é `matchedCount / totalCriteria` — uma
 * razão de critérios atendidos, exposta como `score`, com `matched: true/false` + `reason`
 * por critério. Um score ponderado (ex.: "preço vale 40%") seria um número inventado que não
 * corresponde a nenhuma regra real do produto.
 *
 * Recebe `property` com as suas `offers` já carregadas (include as: 'offers'), ou um array
 * de offers explícito em `options.offers`.
 *
 * Retorno:
 *   {
 *     propertyId,
 *     matched: boolean,           // true só se TODOS os critérios avaliados bateram
 *     score: 0..1,                // critérios atendidos / critérios avaliados
 *     matchedCount, totalCriteria,
 *     criteria: { propertyType: { matched: true }, priceRange: { matched: false, reason: 'Acima do máximo' }, ... }
 *   }
 */
function explainMatch(radar, property, options = {}) {
  const criteria = (radar && radar.criteriaJson) || {};
  const offers = options.offers || property.offers || [];
  const activeOffers = offers.filter((offer) => offer.status === 'ACTIVE');
  const result = {};

  const add = (key, matched, reason) => {
    result[key] = reason === undefined ? { matched } : { matched, reason };
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

  const keys = Object.keys(result);
  const matchedCount = keys.filter((key) => result[key].matched).length;

  return {
    propertyId: property.id,
    matched: matchedCount === keys.length,
    matchedCount,
    totalCriteria: keys.length,
    score: keys.length === 0 ? 1 : Number((matchedCount / keys.length).toFixed(4)),
    criteria: result,
  };
}

module.exports = { matchRadarToProperties, explainMatch };
