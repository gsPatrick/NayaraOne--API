'use strict';

/**
 * Minimização (M9-D027): devolve só os campos da lista branca. Caminho "a.b.c"; onde há lista, cada item é percorrido com o mesmo
 * caminho. Campo fora da lista não passa, em qualquer profundidade. Pedir um objeto inteiro ("a") leva o objeto todo.
 */
function toTree(paths) {
  const root = {};
  for (const path of paths) {
    const parts = path.split('.');
    let node = root;
    for (let i = 0; i < parts.length; i += 1) {
      if (i === parts.length - 1) { node[parts[i]] = true; break; }
      if (node[parts[i]] === true) break;
      node[parts[i]] = node[parts[i]] || {};
      node = node[parts[i]];
    }
  }
  return root;
}

function pick(value, node) {
  if (node === true) return value;
  if (Array.isArray(value)) return value.map((item) => pick(item, node));
  if (value === null || typeof value !== 'object') return undefined;
  const out = {};
  for (const [key, child] of Object.entries(node)) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
    const picked = pick(value[key], child);
    if (picked !== undefined) out[key] = picked;
  }
  return out;
}

function pickFields(data, paths) {
  if (!Array.isArray(paths) || paths.length === 0) return {};
  return pick(data, toTree(paths)) || {};
}

/** Valores de texto nos caminhos (percorrendo listas). */
function valuesAt(data, path) {
  let atual = [data];
  for (const part of path.split('.')) {
    atual = atual.flatMap((v) => (Array.isArray(v) ? v : [v])).filter((v) => v && typeof v === 'object').map((v) => v[part]);
  }
  return atual.flatMap((v) => (Array.isArray(v) ? v : [v])).filter((v) => typeof v === 'string' && v.trim().length > 0);
}

module.exports = { pickFields, valuesAt };
