'use strict';

/** Saída do ai-dod-check (M9-D047): a matriz dos 16 itens, a autochecagem e, por item sem prova, a linha de erro "DoD item N sem prova". Passa por `limpar` (sem segredo nem caminho absoluto). */
const { limpar } = require('../../int-autocheck/lib/saida');

const CODIGO = 'AI_DOD_ITEM_MISSING';

function renderizar({ itens, autochecagem }) {
  const out = ['# Definition of Done da IA NAY (M9-D047)'];
  const err = [];
  for (const it of itens) {
    out.push(`${String(it.n).padStart(2)}. [${it.ok ? 'OK   ' : 'FALTA'}] ${it.item} (${it.demandas.join(', ')})`);
    it.falhas.slice(0, 20).forEach((f) => out.push(`      - ${f}`));
    if (!it.ok) err.push(`${CODIGO} DoD item ${it.n} sem prova: ${it.falhas.slice(0, 3).join('; ')}`);
  }
  out.push('', '# Autochecagem (Guia §19)');
  for (const p of autochecagem.perguntas) {
    out.push(`${p.texto} ${p.resposta}`);
    for (const v of p.verificacoes) {
      out.push(`  ${v.ok ? 'OK   ' : 'FALTA'} ${v.nome}`);
      v.detalhes.slice(0, 10).forEach((d) => out.push(`         - ${d}`));
      if (v.detalhes.length > 10) out.push(`         - ... e mais ${v.detalhes.length - 10}`);
    }
    if (!p.ok) err.push(`${CODIGO} Autochecagem: "${p.texto}" respondeu NÃO.`);
  }
  const verdes = itens.filter((i) => i.ok).length;
  out.push('', `${verdes} de ${itens.length} itens com prova; ${autochecagem.perguntas.filter((p) => p.ok).length} de 4 perguntas com SIM`);
  const ok = verdes === itens.length && autochecagem.ok;
  return { code: ok ? 0 : 1, stdout: `${limpar(out.join('\n'))}\n`, stderr: err.length ? `${limpar(err.join('\n'))}\n` : '' };
}

module.exports = { renderizar, CODIGO };
