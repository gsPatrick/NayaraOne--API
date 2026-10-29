'use strict';

/** Característica do cadastro (attributes_json) -> texto público. É a mesma lista da visão pública do Marketing (M9-D403). */
const FLAG_FEATURES = Object.freeze([
  ['pool', 'piscina'], ['barbecue', 'churrasqueira'], ['balcony', 'varanda'], ['elevator', 'elevador'], ['gym', 'academia'],
  ['playground', 'playground'], ['partyRoom', 'salão de festas'], ['concierge24h', 'portaria 24h'], ['airConditioning', 'ar-condicionado'],
  ['furnished', 'mobiliado'], ['petsFriendly', 'aceita pets'],
]);

const numberAttr = (attrs, key) => (attrs && typeof attrs[key] === 'number' && Number.isFinite(attrs[key]) ? attrs[key] : null);

/** Lista pública de características a partir do JSON de atributos do imóvel. */
function publicFeatures(attributes) {
  const attrs = attributes && typeof attributes === 'object' ? attributes : {};
  const list = FLAG_FEATURES.filter(([key]) => attrs[key] === true).map(([, label]) => label);
  if ((numberAttr(attrs, 'coveredParkingSpots') || 0) > 0) list.push('vaga coberta');
  return list;
}

module.exports = { publicFeatures, numberAttr };
