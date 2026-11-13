'use strict';

/**
 * Prova de que um valor recusado pelo banco veio do PEDIDO (rodada 8 da verificação do Marco 9, 12/11/2026; DI-M9R-25).
 *
 * Um erro de dado ou de integridade do Postgres (classes 22 e 23) só é do cliente quando o valor que o banco recusou foi o que o cliente mandou.
 * Divisão por zero, texto montado pelo servidor maior que a coluna, constante do código que não converte, NOT NULL esquecido pelo código: o valor não
 * está no pedido, e o erro é do servidor (500, registrado como ERRO com a pilha). Aqui ficam as peças da prova:
 * - `folhasDoPedido`: os valores simples (texto, número, booleano, null) do caminho (segmentos da URL), da consulta e do corpo, cada um com o nome do
 *   campo que o contém (iterativo; a forma do pedido já foi limitada na porta);
 * - `achar`: a folha cujo valor é o mesmo (como texto, sem espaços nas pontas e sem diferença de maiúsculas, que é o que os serviços fazem antes de
 *   gravar) e, quando a coluna é conhecida, cujo nome é o do atributo ou o da coluna.
 */
const MAX_FOLHAS = 200000;

/** [{ campo, valor, parte }] de params, query e body. Itens de lista herdam o nome do campo da lista. */
function folhasDoPedido(req) {
  const folhas = [];
  if (!req) return folhas;
  const pilha = [];
  for (const parte of ['params', 'query', 'body']) if (req[parte] !== undefined) pilha.push([req[parte], parte, parte]);
  // O Express devolve `req.params` ao estado do router de fora quando o erro sai da rota: no errorHandler os parâmetros do caminho já se perderam.
  // Os segmentos do próprio caminho pedido (decodificados) são a mesma informação.
  for (const segmento of String(req.originalUrl || req.url || '').split('?')[0].split('/')) {
    if (!segmento) continue;
    let texto = segmento;
    try { texto = decodeURIComponent(segmento); } catch (_e) { /* fica o segmento cru */ }
    folhas.push({ campo: 'caminho', valor: texto, parte: 'params' });
  }
  while (pilha.length > 0 && folhas.length < MAX_FOLHAS) {
    const [atual, campo, parte] = pilha.pop();
    if (atual === null || ['string', 'number', 'boolean'].includes(typeof atual)) { folhas.push({ campo, valor: atual, parte }); continue; }
    if (typeof atual !== 'object' || Buffer.isBuffer(atual)) continue;
    if (Array.isArray(atual)) { for (const item of atual) pilha.push([item, campo, parte]); continue; }
    for (const chave of Object.keys(atual)) pilha.push([atual[chave], chave, parte]);
  }
  return folhas;
}

const normal = (v) => (v === null || v === undefined ? null : String(v).trim().toUpperCase());

/**
 * Primeira folha do pedido com o valor `valor` (comparado como texto normalizado) e, se `nomes` vier, com o nome do campo entre eles. `aceitaNulo`:
 * a folha pode ser null ou '' (prova do NOT NULL: o cliente mandou o campo vazio).
 */
function achar(folhas, { valor, nomes = null, aceitaNulo = false }) {
  const alvo = normal(valor);
  for (const f of folhas) {
    if (nomes && !nomes.includes(f.campo)) continue;
    if (aceitaNulo) { if (f.valor === null || (typeof f.valor === 'string' && f.valor.trim() === '')) return f; continue; }
    if (alvo !== null && normal(f.valor) === alvo) return f;
  }
  return null;
}

/** Nomes pelos quais um campo pode ter vindo no pedido: o atributo do modelo e a coluna. */
const nomesDoCampo = (coluna, atributo) => [...new Set([atributo, coluna].filter(Boolean))];

module.exports = { folhasDoPedido, achar, nomesDoCampo, normal };
