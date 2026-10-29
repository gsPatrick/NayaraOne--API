'use strict';

/** M9-D707 — a matriz do DoD em texto: uma linha por item (SIM/NÃO) e, abaixo, a razão de cada NÃO. */
function formatarMatriz(resultado) {
  const linhas = [];
  for (const i of resultado.itens) {
    linhas.push(`${String(i.n).padStart(2)}. ${i.livro}: ${i.ok ? 'SIM' : 'NÃO'}`);
    i.motivos.forEach((m) => linhas.push(`      - ${m}`));
  }
  return linhas.join('\n');
}

function resumoDeReprovacao(resultado) {
  const nao = resultado.itens.filter((i) => !i.ok);
  return `Reprovado: ${nao.length} item(ns) do DoD do BI não atendido(s): ${nao.map((i) => `${i.n} (${i.livro})`).join('; ')}.`;
}

module.exports = { formatarMatriz, resumoDeReprovacao };
