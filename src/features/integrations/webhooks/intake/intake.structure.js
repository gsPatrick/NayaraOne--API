'use strict';

const { isStorableText } = require('../../../../utils/storableText');

/**
 * Rodada 6 da verificação do Marco 9 (DI-M9R-15): texto com caractere nulo ou metade solta de par sub-rogado não cabe no jsonb da caixa de entrada (antes o
 * evento assinado dava 500 e o fornecedor reenviava em laço). Vai à fila morta como os demais limites de estrutura, SEM o corpo (`body: null`): o erro de
 * integração também é jsonb e recusaria o mesmo texto.
 */
const TEXTO_NAO_GRAVAVEL = Object.freeze({ reason: 'STRUCTURE_LIMIT', detail: 'Um texto do evento tem um caractere que não pode ser gravado (nulo ou metade solta de um caractere Unicode).', body: null });

/**
 * Limites de estrutura do JSON já lido (M9-D213 3.2): profundidade, quantidade total de chaves e tamanho de cada texto. Percurso iterativo (sem recursão), que
 * para no primeiro limite estourado. Devolve null ou { reason: 'STRUCTURE_LIMIT', detail } (sem copiar nenhum valor do evento para a mensagem).
 */
function structureProblem(body, { maxDepth, maxKeys, maxStringLength }) {
  let keys = 0;
  let chaveNaoGravavel = false;
  const pilha = [[body, 1]];
  while (pilha.length) {
    const [valor, profundidade] = pilha.pop();
    if (typeof valor === 'string') {
      if (valor.length > maxStringLength) return { reason: 'STRUCTURE_LIMIT', detail: `Um texto do evento passa de ${maxStringLength} caracteres.` };
      if (!isStorableText(valor)) return TEXTO_NAO_GRAVAVEL;
    } else if (valor && typeof valor === 'object') {
      if (profundidade > maxDepth) return { reason: 'STRUCTURE_LIMIT', detail: `O evento passa de ${maxDepth} níveis de profundidade.` };
      const filhos = Array.isArray(valor) ? valor : Object.entries(valor).flatMap(([k, v]) => {
        keys += 1;
        if (k.length > maxStringLength) keys = Infinity;
        if (!isStorableText(k)) chaveNaoGravavel = true;
        return [v];
      });
      if (keys > maxKeys) return { reason: 'STRUCTURE_LIMIT', detail: `O evento passa de ${maxKeys} chaves.` };
      if (chaveNaoGravavel) return TEXTO_NAO_GRAVAVEL;
      filhos.forEach((f) => pilha.push([f, profundidade + 1]));
    }
  }
  return null;
}

module.exports = { structureProblem };
