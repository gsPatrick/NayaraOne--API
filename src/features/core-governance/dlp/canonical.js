'use strict';

/** JSON com as chaves em ordem alfabética: o jsonb do banco reordena as chaves, então comparar o pedido guardado com o novo exige a forma canônica. */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value === undefined ? null : value);
}

const sameJson = (a, b) => canonical(a) === canonical(b);

module.exports = { canonical, sameJson };
