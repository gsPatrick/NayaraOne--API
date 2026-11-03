'use strict';

/** Saída do ai-dod-check (M9-D047): a matriz dos 16 itens, a autochecagem e, por item sem prova, a linha de erro "DoD item N sem prova". Passa por `limpar` (sem segredo nem caminho absoluto). */
const { limpar } = require('../../int-autocheck/lib/saida');

const CODIGO = 'AI_DOD_ITEM_MISSING';

function renderizar({ itens, autochecagem, semDemandas = false }) {
  const out = ['# Definition of Done da IA NAY (M9-D047)'];
  if (semDemandas) out.push('NAO_APLICAVEL_NO_CI: demandas em Maturacao/demandas/marco-9 ausentes (CI_SEM_REPOS_IRMAOS=1); o status das demandas e a autochecagem NAO foram calculados aqui, cobertos na suíte local. Os testes verdes e o relatório adversarial continuam exigidos.');
  const err = [];
  for (const it of itens) {
    out.push(`${String(it.n).padStart(2)}. [${it.ok ? 'OK   ' : 'FALTA'}] ${it.item} (${it.demandas.join(', ')})`);
    it.falhas.slice(0, 20).forEach((f) => out.push(`      - ${f}`));
    if (!it.ok) err.push(`${CODIGO} DoD item ${it.n} sem prova: ${it.falhas.slice(0, 3).join('; ')}`);
  }
  out.push('', '# Autochecagem (Guia §19)');
  if (!autochecagem) out.push('NAO_APLICAVEL_NO_CI: a autochecagem lê as demandas, ausentes neste CI.');
  for (const p of autochecagem ? autochecagem.perguntas : []) {
    out.push(`${p.texto} ${p.resposta}`);
    for (const v of p.verificacoes) {
      out.push(`  ${v.ok ? 'OK   ' : 'FALTA'} ${v.nome}`);
      v.detalhes.slice(0, 10).forEach((d) => out.push(`         - ${d}`));
      if (v.detalhes.length > 10) out.push(`         - ... e mais ${v.detalhes.length - 10}`);
    }
    if (!p.ok) err.push(`${CODIGO} Autochecagem: "${p.texto}" respondeu NÃO.`);
  }
  const verdes = itens.filter((i) => i.ok).length;
  out.push('', `${verdes} de ${itens.length} itens com prova; ${autochecagem ? `${autochecagem.perguntas.filter((p) => p.ok).length} de 4 perguntas com SIM` : 'autochecagem NAO_APLICAVEL_NO_CI'}`);
  const ok = verdes === itens.length && (!autochecagem || autochecagem.ok);
  return { code: ok ? 0 : 1, stdout: `${limpar(out.join('\n'))}\n`, stderr: err.length ? `${limpar(err.join('\n'))}\n` : '' };
}

module.exports = { renderizar, CODIGO };
