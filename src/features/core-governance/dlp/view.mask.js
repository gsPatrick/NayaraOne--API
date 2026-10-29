'use strict';

const MASK_CHAR = '*';
const FULL_MASK = '********';

/**
 * Máscara do valor sensível devolvido a quem não pode vê-lo em claro (M9-D825 §3.1). `keep` = quantos caracteres finais ainda aparecem (parâmetro
 * `governanca.dlp.view.mascara_ultimos`, padrão 4: `****1234`); valores curtos (até o dobro de `keep`) e a falha da política saem em máscara TOTAL. A máscara por campo
 * do registro de classificação (M9-D915) substitui esta função pelo encaixe da fonte de campos; sem ela, vale a regra acima.
 */
function maskValue(value, { keep = 0, full = false } = {}) {
  if (value === null || value === undefined) return value;
  if (full || typeof value !== 'string' || keep < 1 || value.length <= keep * 2) return FULL_MASK;
  return `${MASK_CHAR.repeat(4)}${value.slice(-keep)}`;
}

module.exports = { maskValue, FULL_MASK };
