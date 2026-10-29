'use strict';

/** M9-D707 — leitura da saída do `node --test` (reporter spec ou TAP) e conferência estática dos arquivos que o DoD cita. */
const fs = require('node:fs');
const path = require('node:path');

const escapar = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const nomeVerde = (saida, nome) => new RegExp(`^\\s*(?:✔|ok \\d+ -)\\s+${escapar(nome)}(?:\\s|$)`, 'm').test(saida);

/** Nomes `m9d704 advNN` que aparecem verdes na saída (distintos). */
function adversariaisVerdes(saida) {
  const nomes = new Set();
  for (const m of saida.matchAll(/^\s*(?:✔|ok \d+ -)\s+(m9d704 adv(\d\d)) /gm)) nomes.add(m[2]);
  return [...nomes].sort();
}

/** `{ pulados, falhos }` do resumo final; teste pulado ou `todo` reprova o item (no banco descartável nada fica pulado). */
function resumoDaSaida(saida) {
  const n = (rot) => { const m = saida.match(new RegExp(`(?:ℹ|#)\\s+${rot}\\s+(\\d+)`)); return m ? Number(m[1]) : 0; };
  return { pulados: n('skipped') + n('todo'), falhos: n('fail'), passou: n('pass') };
}

/** Arquivos que casam com o padrão (aceita `*` no nome do arquivo). */
function expandir(raiz, padrao) {
  if (!padrao.includes('*')) return fs.existsSync(path.join(raiz, padrao)) ? [padrao] : [];
  const dir = path.dirname(padrao);
  const re = new RegExp(`^${escapar(path.basename(padrao)).replace(/\\\*/g, '.*')}$`);
  const abs = path.join(raiz, dir);
  return fs.existsSync(abs) ? fs.readdirSync(abs).filter((f) => re.test(f)).sort().map((f) => path.join(dir, f)) : [];
}

/** Problemas estáticos do item: padrão sem arquivo, teste nomeado que não existe no arquivo. */
function problemasEstaticos(raiz, item) {
  const out = [];
  for (const g of item.testes) {
    for (const padrao of g.arquivos) if (!expandir(raiz, padrao).length) out.push(`arquivo de teste inexistente: ${padrao}`);
    for (const nome of g.nomes || []) {
      const achou = g.arquivos.some((a) => expandir(raiz, a).some((f) => fs.readFileSync(path.join(raiz, f), 'utf8').includes(`test('${nome}'`)));
      if (!achou) out.push(`teste nomeado inexistente: ${nome}`);
    }
  }
  return out;
}

module.exports = { nomeVerde, adversariaisVerdes, resumoDaSaida, expandir, problemasEstaticos };
