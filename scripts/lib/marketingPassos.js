'use strict';

/**
 * M9-D444 — leitura dos 11 passos da "Ordem exata" do Marketing (seção 3.2 da M9-D444) e do mapa de sprints repetido na seção 3.1 da própria M9-D444.
 * Somente leitura, sem banco. O mapa de sprints da seção 3.1 precisa ser idêntico ao da M9-D439 (fonte única); a comparação está em `marketingPortao.js`.
 *   lerPassos(textoD444)          [{ n, nome, ids }]   (um passo por linha da tabela 3.2)
 *   lerMapaD444(textoD444)        { M1: ['M9-D400', ...], ... }   (seção 3.1 da M9-D444)
 *   lerPassosDoLivro(caderno)     ['templates/content', ...]       ("Ordem exata" do Guia §1)
 */
const { expandirIds } = require('./marketingSprints');

const TOTAL_PASSOS = 11;

/** Tabela "| Passo do livro | Demandas |" da seção 3.2. Lança erro claro se não existe. */
function lerPassos(textoD444) {
  const linhas = String(textoD444).split('\n');
  const inicio = linhas.findIndex((l) => l.startsWith('| Passo do livro |'));
  if (inicio < 0) throw new Error('M9-D444: tabela de passos (seção 3.2) não encontrada');
  const passos = [];
  for (const linha of linhas.slice(inicio + 2)) {
    if (!linha.startsWith('|')) break;
    const [, primeira, demandas] = linha.split('|');
    const m = String(primeira).trim().match(/^(\d+)\s+(.+)$/);
    if (m) passos.push({ n: Number(m[1]), nome: m[2].trim(), ids: expandirIds(demandas) });
  }
  return passos;
}

/** Mapa da seção 3.1 da M9-D444: "M1: D400, D402, .... M2: ...". */
function lerMapaD444(textoD444) {
  const texto = String(textoD444);
  const ini = texto.indexOf('### 3.1');
  const fim = texto.indexOf('### 3.2');
  if (ini < 0 || fim < 0) throw new Error('M9-D444: seção 3.1 (mapa demanda -> sprint) não encontrada');
  const corpo = texto.slice(ini, fim).split('\n').find((l) => /\bM1:/.test(l)) || '';
  const mapa = {};
  for (const m of corpo.matchAll(/\b(M[1-9]):\s*([^:]*?)(?=\s+M[1-9]:|\s+Total:|$)/g)) mapa[m[1]] = expandirIds(m[2]);
  return mapa;
}

/** "1 templates/content; 2 content validation; ... 11 tests/failure drills." da "Ordem exata" do Guia (a primeira ocorrência com os 11 passos). */
function lerPassosDoLivro(textoCaderno) {
  const re = /1\s+templates\/content;\s*2\s+content validation;[^.]*?11\s+tests\/failure drills/;
  const m = String(textoCaderno).replace(/\s+/g, ' ').match(re);
  if (!m) throw new Error('Ordem exata do Marketing não encontrada no caderno');
  return m[0].split(';').map((p) => p.trim().replace(/^\d+\s+/, ''));
}

module.exports = { TOTAL_PASSOS, lerPassos, lerMapaD444, lerPassosDoLivro };
