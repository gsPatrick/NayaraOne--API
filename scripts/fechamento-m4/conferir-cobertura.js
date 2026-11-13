#!/usr/bin/env node
'use strict';
/**
 * Confere a cobertura da captura contra a matriz do Marco 4: toda linha do caderno (265 do
 * docs/entrega-marco45/base.json + 8 linhas novas) tem ao menos uma resposta HTTP real conferida
 * (ok) e nenhuma captura é usada em mais de 3 linhas. Sai com código 1 se algo faltar.
 *   node scripts/fechamento-m4/conferir-cobertura.js <captura.json>
 */
const fs = require('node:fs');
const path = require('node:path');

const NOVAS = ['M4-§1', 'M4-§3.3', 'M4-§3.4', 'M4-§9.1', 'M4-§15.1', 'M4-§15.2', 'M4-§22', 'M4-G§22'];
const base = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'docs', 'entrega-marco45', 'base.json'), 'utf8'));
const ids = [...base.matriz.filter((x) => x.marco === 'Marco 4').map((x) => x.id), ...NOVAS];
const cap = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const http = cap.passos.filter((p) => p.tipo === 'http');

const porLinha = new Map(ids.map((i) => [i, []]));
const desconhecidas = new Set();
for (const p of http) {
  for (const l of p.linhas || []) {
    if (!porLinha.has(l)) desconhecidas.add(l);
    else porLinha.get(l).push(p);
  }
}
const semCaptura = ids.filter((i) => porLinha.get(i).length === 0);
const soDivergente = ids.filter((i) => porLinha.get(i).length > 0 && !porLinha.get(i).some((p) => p.ok));
const reuso = http.filter((p) => (p.linhas || []).length > 3).map((p) => p.id);
const divergentes = http.filter((p) => !p.ok).map((p) => `${p.id} (${p.metodo} ${p.rota} -> ${p.status} ${p.codigo})`);

console.log(`linhas: ${ids.length}; passos HTTP: ${http.length} (${http.filter((p) => p.ok).length} ok, ${divergentes.length} divergentes); consultas: ${cap.consultas.length} (${cap.consultas.filter((q) => q.invarianteOk).length} invariantes ok)`);
console.log(`sem captura: ${semCaptura.length ? semCaptura.join(', ') : 'nenhuma'}`);
console.log(`só com captura divergente: ${soDivergente.length ? soDivergente.join(', ') : 'nenhuma'}`);
console.log(`capturas em mais de 3 linhas: ${reuso.length ? reuso.join(', ') : 'nenhuma'}`);
console.log(`ids de linha desconhecidos: ${desconhecidas.size ? [...desconhecidas].join(', ') : 'nenhum'}`);
if (divergentes.length) console.log(`divergentes:\n  ${divergentes.join('\n  ')}`);
const falhas = cap.consultas.filter((q) => !q.invarianteOk).map((q) => `${q.id}: ${JSON.stringify(q.resultado).slice(0, 200)}`);
if (falhas.length) console.log(`invariantes com falha:\n  ${falhas.join('\n  ')}`);
process.exit(semCaptura.length || reuso.length || desconhecidas.size || soDivergente.length ? 1 : 0);
