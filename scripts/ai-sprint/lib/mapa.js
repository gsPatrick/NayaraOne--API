'use strict';

/**
 * M9-D045 — o mapa da ordem de implementação da NAY. A fonte única é a seção 3 do arquivo da própria demanda M9-D045 (os 12 passos do livro,
 * a lista de transversais e os 10 sprints AI1 a AI10); este módulo só a lê, nunca guarda cópia. Números: "D035 a D041" é intervalo.
 */
const LINHA_SPRINT = /^\|\s*(AI(\d+))\s*\|([^|]*)\|([^|]*)\|(.*)\|\s*$/;
const LINHA_PASSO = /^\|\s*(\d{1,2})\s*\|([^|]*)\|([^|]*)\|\s*$/;
const TRANSVERSAIS = /^Transversais a todos os passos:\s*(.*)$/m;

const idCompleto = (n) => `M9-D${String(n).padStart(3, '0')}`;

/** "D010, D011" / "D035 a D041" / "D034 (com D020)" -> ['M9-D010', ...] sem repetição, na ordem em que aparecem. */
function idsDe(texto) {
  const saida = [];
  const s = String(texto);
  const re = /\bD(\d{3})(?:\s+a\s+D(\d{3}))?/g;
  let m = re.exec(s);
  while (m) {
    const de = Number(m[1]);
    const ate = m[2] ? Number(m[2]) : de;
    for (let n = de; n <= ate; n += 1) if (!saida.includes(idCompleto(n))) saida.push(idCompleto(n));
    m = re.exec(s);
  }
  return saida;
}

/** Lê `texto` (a demanda M9-D045) e devolve { sprints, passos, transversais }. Lança erro claro se alguma tabela não existir. */
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
  if (!sprints.length) throw new Error('a tabela dos sprints AI1 a AI10 não foi encontrada na M9-D045');
  if (!passos.length) throw new Error('a tabela dos 12 passos da ordem exata não foi encontrada na M9-D045');
  return { sprints, passos, transversais: t ? idsDe(t[1]) : [] };
}

module.exports = { lerMapa, idsDe, idCompleto };
