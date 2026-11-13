'use strict';

/**
 * Preferências, critérios flexíveis e exclusões do Radar (Marco 3 §13), avaliados em memória sobre o imóvel já carregado
 * (com `address` e `offers`). Função pura: nada de banco. Cada item vira uma entrada da explicação:
 *   { category: 'PREFERENCE'|'FLEXIBLE'|'EXCLUSION', code, weight?, matched, reason? }
 * Em EXCLUSION, `matched: true` quer dizer "a exclusão não se aplica" (o critério foi atendido); exclusão que bate sai
 * `matched: false` e tira o imóvel do match.
 */
const norm = (v) => String(v === undefined || v === null ? '' : v).normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase();
const num = (v) => (v === undefined || v === null || v === '' ? null : Number(v));
const attrs = (property) => {
  const a = property.attributesJson;
  return a && typeof a === 'object' && !Array.isArray(a) ? a : {};
};

function haversineKm(lat1, lng1, lat2, lng2) {
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(lat2 - lat1);
  const dLng = rad(lng2 - lng1);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

function atLeast(actual, expected, label) {
  if (actual === null || Number.isNaN(actual)) return { matched: false, reason: `Imóvel sem ${label} cadastrado.` };
  return actual >= Number(expected) ? { matched: true } : { matched: false, reason: `${label[0].toUpperCase()}${label.slice(1)}: ${actual}, o radar prefere pelo menos ${expected}.` };
}

function preference(item, property) {
  switch (item.code) {
    case 'NEIGHBORHOOD': {
      const actual = property.address && property.address.neighborhood;
      if (!actual) return { matched: false, reason: 'Imóvel sem bairro cadastrado.' };
      return norm(actual) === norm(item.value) ? { matched: true } : { matched: false, reason: `Bairro é "${actual}", o radar prefere "${item.value}".` };
    }
    case 'MIN_BEDROOMS': return atLeast(num(property.bedrooms), item.value, 'quartos');
    case 'MIN_SUITES': return atLeast(num(attrs(property).suites), item.value, 'suítes');
    case 'MIN_PARKING': return atLeast(num(property.parkingSpots), item.value, 'vagas de garagem');
    default: return { matched: false, reason: `Critério ${item.code} desconhecido.` };
  }
}

function attributeEquals(property, key, value) {
  const a = attrs(property);
  return Object.prototype.hasOwnProperty.call(a, key) && norm(a[key]) === norm(value);
}

function flexible(item, property) {
  if (item.code === 'ATTRIBUTE') {
    if (attributeEquals(property, item.key, item.value)) return { matched: true };
    const actual = attrs(property)[item.key];
    return { matched: false, reason: actual === undefined ? `Imóvel sem "${item.key}" cadastrado.` : `"${item.key}" é "${actual}", o radar prefere "${item.value}".` };
  }
  if (item.code === 'MAX_DISTANCE_KM') {
    const lat = num(property.latitude);
    const lng = num(property.longitude);
    if (lat === null || lng === null) return { matched: false, reason: 'Imóvel sem coordenadas cadastradas.' };
    const km = Number(haversineKm(Number(item.lat), Number(item.lng), lat, lng).toFixed(2));
    return km <= Number(item.value) ? { matched: true, distanceKm: km } : { matched: false, distanceKm: km, reason: `Fica a ${km} km do ponto, o radar aceita até ${item.value} km.` };
  }
  return { matched: false, reason: `Critério ${item.code} desconhecido.` };
}

function exclusion(item, property) {
  if (item.code === 'PROPERTY_TYPE') {
    const hit = norm(property.propertyType) === norm(item.value);
    return hit ? { matched: false, reason: `Excluído: o cliente não aceita imóvel do tipo "${String(item.value).toUpperCase()}".` } : { matched: true };
  }
  if (item.code === 'ATTRIBUTE') {
    const hit = attributeEquals(property, item.key, item.value);
    return hit ? { matched: false, reason: `Excluído: o cliente não aceita "${item.key}" = "${item.value}".` } : { matched: true };
  }
  return { matched: true };
}

const keyFor = (category, item) => `${category.toLowerCase()}:${item.code}${item.key ? `:${item.key}` : ''}${category === 'EXCLUSION' && item.code === 'PROPERTY_TYPE' ? `:${String(item.value).toUpperCase()}` : ''}`;

/** Entradas da explicação para preferências, flexíveis e exclusões, com chave única por item. */
function evaluateExtras(normalized, property) {
  const out = [];
  const used = new Set();
  const push = (category, item, result) => {
    let key = keyFor(category, item);
    for (let n = 2; used.has(key); n += 1) key = `${keyFor(category, item)}#${n}`;
    used.add(key);
    const entry = { category, code: item.code, ...(category === 'EXCLUSION' ? {} : { weight: item.weight }), ...result };
    out.push([key, entry]);
  };
  for (const item of normalized.preferences) push('PREFERENCE', item, preference(item, property));
  for (const item of normalized.flexible) push('FLEXIBLE', item, flexible(item, property));
  for (const item of normalized.exclusions) push('EXCLUSION', item, exclusion(item, property));
  return out;
}

/**
 * Pontuação do Guia §9: obrigatório que falhou ou exclusão que bateu -> { matched: false, score: 0 }; senão score = pesos
 * atendidos / pesos totais de preferências e flexíveis (1 quando não há nenhum).
 */
function scoreOf(criteria) {
  const entries = Object.values(criteria);
  const requiredFailed = entries.some((e) => e.category === 'REQUIRED' && !e.matched);
  const excluded = entries.some((e) => e.category === 'EXCLUSION' && !e.matched);
  const weighted = entries.filter((e) => e.category === 'PREFERENCE' || e.category === 'FLEXIBLE');
  const total = weighted.reduce((s, e) => s + e.weight, 0);
  const got = weighted.filter((e) => e.matched).reduce((s, e) => s + e.weight, 0);
  const reasons = [...(requiredFailed ? ['REQUIRED_FAILED'] : []), ...(excluded ? ['EXCLUDED'] : [])];
  if (reasons.length) return { matched: false, score: 0, reasons };
  return { matched: true, score: total === 0 ? 1 : Number((got / total).toFixed(4)), reasons: weighted.filter((e) => e.matched).map((e) => e.code) };
}

module.exports = { evaluateExtras, scoreOf, haversineKm };
