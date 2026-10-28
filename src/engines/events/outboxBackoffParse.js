'use strict';

/** Converte "60000,300000" em lista de inteiros positivos; devolve null se o texto for inválido. */
function parseBackoffList(text) {
  if (typeof text !== 'string' || !/^\s*\d+(\s*,\s*\d+)*\s*$/.test(text)) return null;
  const list = text.split(',').map((x) => Number(x.trim()));
  return list.every((n) => Number.isSafeInteger(n) && n > 0) ? list : null;
}

module.exports = { parseBackoffList };
