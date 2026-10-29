'use strict';

const crypto = require('node:crypto');

const METERS_PER_DEGREE = 111320;
// A distância fica entre 10% e 95% do raio: nunca o ponto exato e nunca além do raio (sobra para o arredondamento a 5 casas).
const MIN_FRACTION = 0.1;
const SPAN_FRACTION = 0.85;
const DECIMALS = 5;

const round = (value) => Number(value.toFixed(DECIMALS));

/**
 * approximateCoordinate — desloca o ponto de forma DETERMINÍSTICA (hash do id do imóvel) dentro de `radiusM` metros. O mesmo imóvel
 * dá sempre a mesma coordenada em qualquer publicação (estável); o ponto exato nunca é devolvido. Entrada fora de faixa: null.
 */
function approximateCoordinate(lat, lng, propertyId, radiusM) {
  const la = Number(lat);
  const lo = Number(lng);
  if (!Number.isFinite(la) || !Number.isFinite(lo) || Math.abs(la) > 90 || Math.abs(lo) > 180) return null;
  const digest = crypto.createHash('sha256').update(String(propertyId)).digest();
  const u1 = digest.readUInt32BE(0) / 2 ** 32;
  const u2 = digest.readUInt32BE(4) / 2 ** 32;
  const distance = radiusM * (MIN_FRACTION + SPAN_FRACTION * Math.sqrt(u1));
  const angle = 2 * Math.PI * u2;
  const dLat = (distance * Math.cos(angle)) / METERS_PER_DEGREE;
  const dLng = (distance * Math.sin(angle)) / (METERS_PER_DEGREE * Math.max(Math.cos((la * Math.PI) / 180), 0.01));
  return { lat: round(la + dLat), lng: round(lo + dLng) };
}

/** Coordenada exata (visibilidade PUBLIC), arredondada a 5 casas (cerca de 1 m). */
function exactCoordinate(lat, lng) {
  const la = Number(lat);
  const lo = Number(lng);
  if (!Number.isFinite(la) || !Number.isFinite(lo) || Math.abs(la) > 90 || Math.abs(lo) > 180) return null;
  return { lat: round(la), lng: round(lo) };
}

module.exports = { approximateCoordinate, exactCoordinate };
