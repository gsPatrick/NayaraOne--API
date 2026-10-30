'use strict';

/** Matriz do Definition of Done da NAY (M9-D047): docs/ai/dod-ia-nay.json. Aqui só se confere a forma (16 itens do livro, provas nomeadas, item 14 em duas famílias). */
const fs = require('node:fs');
const path = require('node:path');

const RAIZ = path.resolve(__dirname, '..', '..', '..');
const ARQUIVO = path.join(RAIZ, 'docs', 'ai', 'dod-ia-nay.json');
const ITENS_DO_LIVRO = 16;
const ITEM_REDACTION_E_RLS = 14;
const MINIMO_RLS = 3;

function carregar(arquivo = ARQUIVO) {
  return JSON.parse(fs.readFileSync(arquivo, 'utf8'));
}

/** Problemas da forma da matriz (vazio = coerente com o livro). */
function problemasDaMatriz(matriz) {
  const itens = Array.isArray(matriz && matriz.itens) ? matriz.itens : [];
  const p = [];
  if (itens.length !== ITENS_DO_LIVRO) p.push(`a matriz lista ${itens.length} itens; o livro tem ${ITENS_DO_LIVRO}`);
  itens.forEach((it, i) => {
    if (it.n !== i + 1) p.push(`o item na posição ${i + 1} está numerado ${it.n}`);
    if (!it.item) p.push(`o item ${it.n} não tem texto do livro`);
    if (!Array.isArray(it.demandas) || !it.demandas.length) p.push(`o item ${it.n} não tem demanda`);
    const nomes = (it.provas || []).map((x) => x.teste);
    if (!nomes.length) p.push(`o item ${it.n} não tem teste`);
    if (new Set(nomes).size !== nomes.length) p.push(`o item ${it.n} repete um nome de teste`);
  });
  const quatorze = itens.find((it) => it.n === ITEM_REDACTION_E_RLS);
  if (quatorze) {
    const grupo = (g) => (quatorze.provas || []).filter((x) => x.grupo === g).map((x) => x.teste);
    const redaction = grupo('redaction');
    const rls = grupo('rls');
    if (!redaction.length) p.push('o item 14 não tem teste de redaction');
    if (rls.length < MINIMO_RLS) p.push(`o item 14 precisa de ${MINIMO_RLS} testes de isolamento entre empresas (RLS) com nomes distintos; tem ${rls.length}`);
    if (redaction.some((n) => rls.includes(n))) p.push('o item 14 usa o mesmo teste como redaction e como RLS');
  }
  return p;
}

module.exports = { carregar, problemasDaMatriz, ARQUIVO, RAIZ, ITENS_DO_LIVRO, ITEM_REDACTION_E_RLS };
