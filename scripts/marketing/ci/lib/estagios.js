'use strict';

/**
 * Definição e validação dos 14 estágios da esteira de CI do Marketing (M9-D438, Guia §12). A ordem e os nomes são os do livro e ficam aqui, fora do arquivo de configuração: um estagios.json
 * reordenado, com estágio a menos, renomeado ou com algum dos estágios 1 a 11 marcado como manual é RECUSADO antes de qualquer comando rodar. Os estágios 1 a 11 rodam em todo push e pull
 * request; 12 a 14 só em branch de entrega. O CI nunca faz deploy em produção e usa sempre banco descartável. A leitura dos arquivos de teste de cada estágio é a mesma das integrações.
 */
const path = require('node:path');
const { comandosDaEtapa, expandir, EsteiraInvalida } = require('../../../int-ci/lib/estagios');

const ROOT = path.join(__dirname, '..', '..', '..', '..');

/** "lint → typecheck → migrations → automation idempotency → consent/suppression tests → factual grounding → public-field leakage tests → provider contract tests → frequency/quiet-hours → kill-switch → tracking tests → DEV → LAB → failure drills". */
const ESTAGIOS_DO_LIVRO = Object.freeze([
  [1, 'lint'], [2, 'typecheck'], [3, 'migrations'], [4, 'automation idempotency'], [5, 'consent/suppression tests'], [6, 'factual grounding'], [7, 'public-field leakage tests'],
  [8, 'provider contract tests'], [9, 'frequency/quiet-hours'], [10, 'kill-switch'], [11, 'tracking tests'], [12, 'DEV'], [13, 'LAB'], [14, 'failure drills'],
]);
const ULTIMO_DE_PUSH = 11;
const CODIGO_FALHA = 'MKT_CI_STAGE_FAILED';
const MENSAGEM_FALHA = 'Um estágio do pipeline falhou; a entrega está bloqueada.';

/** Confere que a lista de estágios é exatamente a do livro. Devolve a lista de problemas (vazia = válida). */
function problemasDaDefinicao(estagios) {
  const problemas = [];
  if (!Array.isArray(estagios)) return ['estagios deve ser uma lista'];
  if (estagios.length !== ESTAGIOS_DO_LIVRO.length) problemas.push(`são ${estagios.length} estágios; o livro tem ${ESTAGIOS_DO_LIVRO.length}`);
  ESTAGIOS_DO_LIVRO.forEach(([numero, nome], i) => {
    const e = estagios[i];
    if (!e) { problemas.push(`estágio ${numero} (${nome}) ausente`); return; }
    if (e.numero !== numero || e.nome !== nome) problemas.push(`posição ${numero}: esperado "${nome}" (${numero}), veio "${e.nome}" (${e.numero}): a ordem do livro não pode mudar`);
    const tipoEsperado = numero <= ULTIMO_DE_PUSH ? 'push' : 'entrega';
    if (e.tipo !== tipoEsperado) problemas.push(`estágio ${numero} (${nome}) é "${e.tipo}"; o livro exige "${tipoEsperado}" (1 a 11 em todo push e pull request, 12 a 14 em branch de entrega)`);
    if (!(Array.isArray(e.comandos) && e.comandos.length)) problemas.push(`estágio ${numero} (${nome}) sem comando`);
    const proibido = JSON.stringify(e.comandos || []).match(/deploy[-_ ]?(prod|production)|production[-_ ]?deploy|--prod\b/i);
    if (proibido) problemas.push(`estágio ${numero} (${nome}) tenta deploy de produção ("${proibido[0]}"): o CI nunca faz deploy em produção`);
  });
  return problemas;
}

/**
 * Testes exigidos do estágio (`exigidos`: nomes de teste do livro). Apagar ou renomear um deles deixa o estágio vermelho ANTES de qualquer comando: a suíte menor continuaria verde, e é isso
 * que a remoção de um teste adversarial ou de uma guarda não pode conseguir. Devolve os nomes que não aparecem em nenhum arquivo dos padrões do estágio.
 */
function testesExigidosAusentes(estagio, raiz = ROOT) {
  const exigidos = estagio.exigidos || [];
  if (!exigidos.length) return [];
  const arquivos = [...new Set((estagio.comandos || []).filter((c) => c && c.testes).flatMap((c) => c.testes.flatMap((padrao) => expandir(padrao, raiz))))];
  const fs = require('node:fs');
  const texto = arquivos.map((f) => fs.readFileSync(path.join(raiz, f), 'utf8')).join('\n');
  return exigidos.filter((nome) => !texto.includes(nome));
}

/** Lê e valida o arquivo de estágios. Lança EsteiraInvalida com todos os problemas. */
function carregar(arquivo) {
  const estagios = (JSON.parse(require('node:fs').readFileSync(arquivo, 'utf8')) || {}).estagios;
  const problemas = problemasDaDefinicao(estagios);
  if (problemas.length) throw new EsteiraInvalida(problemas.join('; '));
  return estagios;
}

module.exports = { ROOT, ESTAGIOS_DO_LIVRO, ULTIMO_DE_PUSH, CODIGO_FALHA, MENSAGEM_FALHA, EsteiraInvalida, problemasDaDefinicao, carregar, testesExigidosAusentes, comandosDaEtapa, expandir };
