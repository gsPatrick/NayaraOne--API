'use strict';

/**
 * Limites de estrutura do JSON já lido (M9-D213 3.2): profundidade, quantidade total de chaves e tamanho de cada texto. Percurso iterativo (sem recursão), que
 * para no primeiro limite estourado. Devolve null ou { reason: 'STRUCTURE_LIMIT', detail } (sem copiar nenhum valor do evento para a mensagem).
 */
function structureProblem(body, { maxDepth, maxKeys, maxStringLength }) {
  let keys = 0;
  const pilha = [[body, 1]];
  while (pilha.length) {
    const [valor, profundidade] = pilha.pop();
    if (typeof valor === 'string') {
      if (valor.length > maxStringLength) return { reason: 'STRUCTURE_LIMIT', detail: `Um texto do evento passa de ${maxStringLength} caracteres.` };
    } else if (valor && typeof valor === 'object') {
      if (profundidade > maxDepth) return { reason: 'STRUCTURE_LIMIT', detail: `O evento passa de ${maxDepth} níveis de profundidade.` };
      const filhos = Array.isArray(valor) ? valor : Object.entries(valor).flatMap(([k, v]) => {
        keys += 1;
        if (k.length > maxStringLength) keys = Infinity;
        return [v];
      });
      if (keys > maxKeys) return { reason: 'STRUCTURE_LIMIT', detail: `O evento passa de ${maxKeys} chaves.` };
      filhos.forEach((f) => pilha.push([f, profundidade + 1]));
    }
  }
  return null;
}

module.exports = { structureProblem };
