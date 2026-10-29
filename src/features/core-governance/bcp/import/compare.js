'use strict';

/**
 * Conferência do papel contra o efeito gravado pelo comando normal (M9-D832 §3.5). Cada adaptador devolve a lista `{ field, label, paper, command, kind }` com os dois lados já
 * normalizados (import/normalize.js). MATCHED só quando TODOS coincidem, sem tolerância; senão DIVERGENT com o `diff` (campo, valor do papel, valor do comando e, para valores em
 * centavos, a diferença).
 */
function compareFields(comparisons) {
  const diff = [];
  for (const item of comparisons) {
    const same = String(item.paper) === String(item.command);
    if (same) continue;
    const entry = { field: item.field, label: item.label, paper: item.paper, command: item.command };
    if (item.kind === 'cents' && Number.isFinite(item.paper) && Number.isFinite(item.command)) entry.differenceCents = Math.abs(item.paper - item.command);
    diff.push(entry);
  }
  return { result: diff.length ? 'DIVERGENT' : 'MATCHED', diff };
}

module.exports = { compareFields };
