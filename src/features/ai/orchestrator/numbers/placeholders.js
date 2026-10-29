'use strict';

// M9-D026 — placeholders {{num:ref}}: o modelo aponta para um item do numbersPayload e o SERVIDOR escreve o valor, em pt-BR,
// com duas casas meio para cima (critério do Financeiro). O modelo nunca escreve, soma nem arredonda o valor.

const { formatPtBr, isDecimalText } = require('./decimalText');

const PLACEHOLDER = /(R\$\s*)?\{\{num:([\w.-]+)\}\}(\s*%)?/g;

/** Item do numbersPayload: { ref, label, value (texto decimal), unit (BRL|%|dias|un), source, asOf }. */
function isPayloadItem(item) {
  return Boolean(item && typeof item.ref === 'string' && isDecimalText(item.value) && ['BRL', '%', 'dias', 'un'].includes(item.unit));
}

function formatItem(item, after = '') {
  const inteiro = /^-?\d+(\.0+)?$/.test(item.value);
  switch (item.unit) {
    case 'BRL': return formatPtBr(item.value, 2).replace(/^(-?)/, '$1R$ ');
    case '%': return `${formatPtBr(item.value, 2)}%`;
    case 'dias': return `${formatPtBr(item.value, inteiro ? 0 : 2)}${/^\s*dias?\b/i.test(after) ? '' : ' dias'}`;
    default: return formatPtBr(item.value, inteiro ? 0 : 2);
  }
}

const refsOf = (text) => [...String(text).matchAll(PLACEHOLDER)].map((m) => m[2]);

/** Troca cada placeholder pelo valor formatado. Placeholder sem item no payload fica de fora (a auditoria já o reprovou). */
function renderPlaceholders(text, numbersPayload) {
  const byRef = new Map((numbersPayload || []).filter(isPayloadItem).map((i) => [i.ref, i]));
  const source = String(text);
  return source.replace(PLACEHOLDER, (all, _brl, ref, _pct, offset) => {
    const item = byRef.get(ref);
    return item ? formatItem(item, source.slice(offset + all.length)) : all;
  });
}

module.exports = { renderPlaceholders, refsOf, isPayloadItem, formatItem, PLACEHOLDER };
