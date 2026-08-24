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

module.exports = { matchRadarToProperties };
