'use strict';

const { randomUUID } = require('node:crypto');

/**
 * Valores dinâmicos dos exemplos (M9-D842): "${nome}" lê uma variável capturada de um exemplo anterior ou embutida (uuid, key, unique, code, ref:AAA, date:+N, datetime:+N). Texto que é só um
 * marcador devolve o valor com o tipo original; marcador no meio do texto é interpolado. Marcador sem valor é erro (o exemplo depende de outro que não rodou).
 */
const DAY = 86400000;
let seq = 0;

function builtin(name) {
  if (name === 'uuid') return randomUUID();
  if (name === 'key') { seq += 1; return `qa-m9-contrato-${Date.now()}-${seq}`; }
  if (name === 'code') { seq += 1; return `qa.contrato.${Date.now()}${seq}`; }
  const ref = /^ref:([A-Z]{3})$/.exec(name);
  if (ref) { seq += 1; return `${ref[1]}-${new Date().getFullYear()}-${String(10000 + ((Date.now() + seq * 7919) % 89999)).padStart(5, '0')}`; }
  if (name === 'unique') { seq += 1; return `QA-M9 ${Date.now()}-${seq}`; }
  const shifted = /^(date|datetime):([+-]\d+)$/.exec(name);
  if (shifted) {
    const when = new Date(Date.now() + Number(shifted[2]) * DAY).toISOString();
    return shifted[1] === 'date' ? when.slice(0, 10) : when;
  }
  return undefined;
}

function lookup(name, vars) {
  if (Object.prototype.hasOwnProperty.call(vars, name)) return vars[name];
  const value = builtin(name);
  if (value === undefined) throw new Error(`O exemplo usa \${${name}} e nenhum exemplo anterior capturou essa variável.`);
  return value;
}

function resolve(node, vars) {
  if (typeof node === 'string') {
    const whole = /^\$\{([^}]+)\}$/.exec(node);
    if (whole) return lookup(whole[1], vars);
    return node.replace(/\$\{([^}]+)\}/g, (_m, name) => String(lookup(name, vars)));
  }
  if (Array.isArray(node)) return node.map((item) => resolve(item, vars));
  if (node && typeof node === 'object') return Object.fromEntries(Object.entries(node).map(([key, value]) => [key, resolve(value, vars)]));
  return node;
}

/** Caminho "a.b.0.c" dentro de um objeto (para `capture`); "a.b#nome" lê o parâmetro `nome` da query do texto-URL achado em a.b. */
function pick(object, dotted) {
  const [route, param] = String(dotted).split('#');
  const value = route.split('.').reduce((cur, part) => (cur === undefined || cur === null ? undefined : cur[part]), object);
  if (!param) return value;
  try { return new URL(String(value), 'http://localhost').searchParams.get(param) || undefined; } catch (_e) { return undefined; }
}

module.exports = { resolve, pick };
