'use strict';

/**
 * M9-D255 — o mapa da ordem de implementação das integrações. A fonte única é a seção 3 do arquivo da própria demanda M9-D255 (os 11 passos do
 * livro, a lista de transversais e os sprints I1 a I9); este módulo só a lê, nunca guarda cópia. "D244 a D250" é intervalo.
 */
const LINHA_SPRINT = /^\|\s*(I(\d+))\s*\|([^|]*)\|([^|]*)\|(.*)\|\s*$/;
const LINHA_PASSO = /^\|\s*(\d{1,2})\s*\|([^|]*)\|([^|]*)\|\s*$/;
const TRANSVERSAIS = /^Transversais[^:\n]*:\s*(.*)$/m;

const idCompleto = (n) => `M9-D${String(n).padStart(3, '0')}`;

/** "D200, D201" / "D244 a D250" / "D229 (`x`) e D222" -> ['M9-D200', ...] sem repetição, na ordem em que aparecem. */
function idsDe(texto) {
  const saida = [];
  const re = /\bD(\d{3})(?:\s+a\s+D(\d{3}))?/g;
  let m = re.exec(String(texto));
  while (m) {
    const de = Number(m[1]);
    const ate = m[2] ? Number(m[2]) : de;
    for (let n = de; n <= ate; n += 1) if (!saida.includes(idCompleto(n))) saida.push(idCompleto(n));
    m = re.exec(String(texto));
  }
  return saida;
}

/** Lê `texto` (a demanda M9-D255) e devolve { sprints, passos, transversais }. Lança erro claro se alguma tabela não existir. */
function lerMapa(texto) {
  const sprints = [];
  const passos = [];
  for (const linha of String(texto).split('\n')) {
    const s = linha.match(LINHA_SPRINT);
    if (s) { sprints.push({ codigo: s[1], n: Number(s[2]), tema: s[3].trim(), demandas: idsDe(s[4]), portao: s[5].trim() }); continue; }
    const p = linha.match(LINHA_PASSO);
    if (p) passos.push({ n: Number(p[1]), nome: p[2].trim(), demandas: idsDe(p[3]) });
  }
  const t = String(texto).match(TRANSVERSAIS);
  if (!sprints.length) throw new Error('a tabela dos sprints I1 a I9 não foi encontrada na M9-D255');
  if (!passos.length) throw new Error('a tabela dos 11 passos da ordem exata não foi encontrada na M9-D255');
  return { sprints, passos, transversais: t ? idsDe(t[1]) : [] };
}

module.exports = { lerMapa, idsDe, idCompleto };
