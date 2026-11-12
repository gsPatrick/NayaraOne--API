'use strict';

/**
 * JSON canônico (chaves dos objetos em ordem): o mesmo conteúdo dá o mesmo texto, qualquer que seja a ordem dos campos. Usado no hash da chave de
 * idempotência (governança da API) e na assinatura do relatório do ensaio de migração.
 *
 * Rodada 7 da verificação do Marco 9 (12/11/2026; DI-M9R-18): a versão anterior era recursiva e estourava a pilha por volta de 3.000 níveis de
 * aninhamento (o corpo de `POST /dlp/copy-events` com `Idempotency-Key` dava 500). Esta é iterativa e produz o MESMO texto da anterior, inclusive
 * nos casos de borda: `undefined` vira `null` (no objeto e na lista), Date e Buffer são percorridos pelas chaves próprias, como antes.
 */
function canonicalJson(value) {
  const partes = [];
  const pilha = [{ valor: value }];
  while (pilha.length > 0) {
    const item = pilha.pop();
    if (item.texto !== undefined) {
      partes.push(item.texto);
      continue;
    }
    const v = item.valor;
    if (Array.isArray(v)) {
      pilha.push({ texto: ']' });
      for (let i = v.length - 1; i >= 0; i -= 1) {
        pilha.push({ valor: v[i], naLista: true });
        if (i > 0) pilha.push({ texto: ',' });
      }
      pilha.push({ texto: '[' });
    } else if (v && typeof v === 'object') {
      const chaves = Object.keys(v).sort();
      pilha.push({ texto: '}' });
      for (let i = chaves.length - 1; i >= 0; i -= 1) {
        pilha.push({ valor: v[chaves[i]] });
        pilha.push({ texto: `${i > 0 ? ',' : ''}${JSON.stringify(chaves[i])}:` });
      }
      pilha.push({ texto: '{' });
    } else {
      // Função e símbolo não têm JSON: na lista saíam vazios (Array.join) e no objeto como "undefined" (texto do modelo), como antes.
      const json = JSON.stringify(v === undefined ? null : v);
      partes.push(json === undefined ? (item.naLista ? '' : 'undefined') : json);
    }
  }
  return partes.join('');
}

module.exports = { canonicalJson };
