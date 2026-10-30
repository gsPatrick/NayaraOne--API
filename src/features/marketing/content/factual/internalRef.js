'use strict';

const { fold } = require('./text');
const { finding } = require('./finding');

/**
 * M9-D433 — varredura de saída: o texto gerado não pode citar ocorrência, reclamação ou anotação interna (Caderno §14: "IA não publica ocorrência interna"). Dados internos
 * não existem no read model público; esta é a segunda barreira, sobre o texto que a NAY (ou a pessoa) escreveu. `terms` vem do parâmetro marketing.factual.termos_internos.
 * Cada termo achado vira um finding INTERNAL_REFERENCE (BLOCK).
 */
function checkInternalReference(text, terms) {
  const folded = fold(String(text || ''));
  const out = [];
  for (const term of terms) {
    const needle = fold(term);
    if (!needle || !new RegExp(`(?:^|[^a-z0-9])${needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(folded)) continue;
    out.push(finding({
      kind: 'INTERNAL_REFERENCE', claim: term, expected: null, found: null, reason: 'INTERNAL_REFERENCE',
      message: 'O texto cita ocorrência, reclamação ou anotação interna; esse tipo de dado nunca vai a canal público.',
    }));
  }
  return out;
}

module.exports = { checkInternalReference };
