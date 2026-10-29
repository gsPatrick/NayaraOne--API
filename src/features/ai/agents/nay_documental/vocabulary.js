'use strict';

const { norm } = require('../scope/scope.evaluate');

/**
 * Lê um parâmetro no formato `CHAVE=item,item;OUTRA=item`: devolve `Map<CHAVE, itens>`. Os itens saem em texto normalizado (sem acento, em
 * minúsculas) quando `normalizeItems` (termos de busca); os nomes de campo (`campos_obrigatorios`) ficam como foram escritos.
 */
function parseVocabulary(raw, { normalizeItems = true } = {}) {
  const out = new Map();
  for (const part of String(raw || '').split(';')) {
    const [key, list] = part.split('=');
    const name = String(key || '').trim().toUpperCase();
    if (!name || list === undefined) continue;
    const items = list.split(',').map((i) => (normalizeItems ? norm(i) : i.trim())).filter(Boolean);
    if (items.length) out.set(name, items);
  }
  return out;
}

module.exports = { parseVocabulary };
