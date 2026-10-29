'use strict';

/**
 * M9-D706 — o mapa sprint -> demandas. A fonte única é a tabela 3.1 do arquivo da própria demanda M9-D706 (o livro: B1 registry/read infra;
 * B2 Finance dashboard; ... B9 carga/rebuild/security); este módulo só a lê. Os 11 passos da ordem exata do Guia §1 estão em PASSOS.
 */
const LINHA = /^\|\s*(B[1-9])\s*\|([^|]*)\|([^|]*)\|([^|]*)\|\s*$/;

/** Lê a tabela 3.1 de `texto` e devolve `{ sprints: [{ codigo, n, escopo, demandas: ['M9-D600', ...], portao }] }`. */
function lerMapa(texto) {
  const sprints = [];
  for (const linha of String(texto).split('\n')) {
    const m = linha.match(LINHA);
    if (!m) continue;
    const demandas = Array.from(new Set((m[3].match(/\b(?:M9-)?D\d{3}\b/g) || []).map((x) => (x.startsWith('M9-') ? x : `M9-${x}`))));
    sprints.push({ codigo: m[1], n: Number(m[1].slice(1)), escopo: m[2].trim(), demandas, portao: m[4].trim() });
  }
  if (!sprints.length) throw new Error('a tabela 3.1 (sprint -> demandas) não foi encontrada na M9-D706');
  return { sprints };
}

/** Ordem exata do Guia §1 (passos 1 a 11) e o(s) sprint(s) que a executam (M9-D706 §3.2). */
const PASSOS = [
  { n: 1, nome: 'metric registry', sprints: ['B1'] },
  { n: 2, nome: 'read models por domínio', sprints: ['B1', 'B2', 'B3', 'B4', 'B5', 'B6'] },
  { n: 3, nome: 'snapshots/freshness', sprints: ['B1'] },
  { n: 4, nome: 'primeiro dashboard Financeiro', sprints: ['B2'] },
  { n: 5, nome: 'CRM/Obras', sprints: ['B3', 'B4'] },
  { n: 6, nome: 'alert engine', sprints: ['B7'] },
  { n: 7, nome: 'drill-down', sprints: ['B7'] },
  { n: 8, nome: 'data quality', sprints: ['B7'] },
  { n: 9, nome: 'NAY briefs', sprints: ['B8'] },
  { n: 10, nome: 'exports', sprints: ['B8'] },
  { n: 11, nome: 'carga/rebuild/security', sprints: ['B9'] },
];

module.exports = { lerMapa, PASSOS };
