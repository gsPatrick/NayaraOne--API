'use strict';

/**
 * Avaliação do Definition of Done das integrações (M9-D253). Função pura sobre um `ambiente` (arquivos, testes, relatórios): o script usa o ambiente real
 * (dodAmbiente.js) e o teste usa um falso. Item sem evidência: INTEGRATION_DOD_ITEM_MISSING, e a saída é 1.
 */
const { lerMatriz, problemasDaMatriz } = require('./matrizInt');

const CODIGO_FALTA = 'INTEGRATION_DOD_ITEM_MISSING';
const MENSAGEM_FALTA = 'Item da definição de pronto sem evidência.';

/** Faltas de uma evidência (lista vazia = evidência presente). */
function faltasDa(ev, amb) {
  if (ev.arquivo) return amb.existeArquivo(ev.arquivo) ? [] : [`arquivo ausente: ${ev.arquivo}`];
  if (ev.teste) return amb.existeTeste(ev.teste) ? [] : [`teste ausente: ${ev.teste}`];
  if (ev.contratos) return amb.contratosFaltando().map((x) => `contrato sem relatório verde: ${x}`);
  if (ev.runbooks) return amb.runbooksFaltando().map((x) => `runbook incompleto: ${x}`);
  if (ev.sandboxes) return amb.familiasSemSandbox().map((x) => `família sem sandbox: ${x}`);
  if (ev.adversariais) {
    const r = amb.adversariais();
    return [...r.problemas.map((p) => `manifesto: ${p}`), ...r.ausentes.map((a) => `teste adversarial ausente: ${a.nome} (item ${a.item} do livro)`)];
  }
  if (ev.autochecagem) {
    if (!amb.autochecagem) return [];
    const r = amb.autochecagem();
    return r && r.code !== 0 ? [`autochecagem reprovou (saída ${r.code})`] : [];
  }
  return [`evidência desconhecida: ${JSON.stringify(ev)}`];
}

/** Item 15: a autochecagem pode declarar-se NAO_APLICAVEL_NO_CI (dodAmbiente.js); aí não gera falta, mas também não conta como evidência. */
function avaliarEvidencias(item, amb) {
  const faltas = [];
  const naoAplicavel = [];
  for (const ev of item.evidencias) {
    const r = ev.autochecagem && amb.autochecagem ? amb.autochecagem() : null;
    if (r && r.naoAplicavel) naoAplicavel.push(r.motivo);
    else faltas.push(...(r ? (r.code !== 0 ? [`autochecagem reprovou (saída ${r.code})`] : []) : faltasDa(ev, amb)));
  }
  return { faltas, naoAplicavel };
}

function avaliar(itens, amb) {
  const resultados = itens.map((item) => {
    const { faltas, naoAplicavel } = avaliarEvidencias(item, amb);
    return { n: item.n, livro: item.livro, ok: faltas.length === 0, faltas, naoAplicavel };
  });
  return { itens: resultados, ok: resultados.every((r) => r.ok) };
}

/** Executa o DoD e a conferência da matriz: { code, stdout, stderr }. */
function executar(itens, amb, matrizMd) {
  const out = [];
  const err = [];
  const r = avaliar(itens, amb);
  out.push('# Definition of Done das integrações');
  for (const it of r.itens) {
    out.push(`${it.ok ? (it.naoAplicavel.length ? 'NAO_APLICAVEL_NO_CI' : 'OK   ') : 'FALTA'} ${String(it.n).padStart(2)} ${it.livro}${it.naoAplicavel.map((m) => ` (${m})`).join('')}`);
    for (const f of it.faltas) err.push(`${CODIGO_FALTA} ${MENSAGEM_FALTA} item ${it.n} (${it.livro}): ${f}`);
  }
  const okItens = r.itens.filter((x) => x.ok && !x.naoAplicavel.length).length;
  const semCalculo = r.itens.filter((x) => x.naoAplicavel.length).length;
  out.push(`${okItens} de ${r.itens.length} itens com evidência${semCalculo ? `, ${semCalculo} NAO_APLICAVEL_NO_CI (nao verificado aqui, coberto na suíte local)` : ''}`);
  const linhas = lerMatriz(matrizMd);
  const problemas = problemasDaMatriz(matrizMd, amb.existeTeste);
  const okPrincipios = linhas.filter((l) => l.demandas.length && l.testes.length && l.testes.every((t) => amb.existeTeste(t))).length;
  out.push('', '# Matriz dos princípios (INT-001 a INT-015)');
  linhas.forEach((l) => out.push(`${l.id} ${l.principio} | ${l.demandas.join(', ')} | ${l.testes.join(', ')}`));
  out.push(`${Math.min(okPrincipios, 15)} de 15 princípios com demanda dona e teste existente`);
  problemas.forEach((p) => err.push(`${CODIGO_FALTA} ${MENSAGEM_FALTA} matriz: ${p}`));
  return { code: r.ok && problemas.length === 0 ? 0 : 1, stdout: `${out.join('\n')}\n`, stderr: err.length ? `${err.join('\n')}\n` : '' };
}

module.exports = { avaliar, executar, faltasDa, CODIGO_FALTA, MENSAGEM_FALTA };
