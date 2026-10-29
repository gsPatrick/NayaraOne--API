'use strict';

// M9-D043 — apoio do teste do manifesto "testes primeiro": leitura do manifesto, localização dos testes nomeados e consultas ao git.

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const RAIZ = path.resolve(__dirname, '../../..');
const CAMINHO_MANIFESTO = path.join(RAIZ, 'test/ai/testes-primeiro.manifest.json');

// Itens 1 a 11 da tabela da demanda (o item 1 tem dois nomes, um por dona).
const NOMES_DO_LIVRO = [
  [1, 'm9d023_retrieval_cross_company_bloqueado'],
  [1, 'm9d017_cross_company_args_de_tool_bloqueado'],
  [2, 'm9d021_injection_em_pdf_nao_altera_tool_policy'],
  [3, 'm9d017_tool_sem_permissao_bloqueada'],
  [4, 'm9d018_argumento_invalido_rejeitado'],
  [5, 'm9d024_fonte_revogada_nao_grounding'],
  [6, 'm9d025_sem_fonte_insuficiencia'],
  [7, 'm9d026_finance_number_igual_read_model'],
  [8, 'm9d014_budget_limit_funciona'],
  [9, 'm9d013_fallback_seguro'],
  [10, 'm9d033_provider_swap_passa_golden_tests'],
  [11, 'm9d019_write_critical_vira_proposal'],
];

function lerManifesto() {
  return JSON.parse(fs.readFileSync(CAMINHO_MANIFESTO, 'utf8'));
}

function lerFonte(relativo) {
  return fs.readFileSync(path.join(RAIZ, relativo), 'utf8');
}

function git(args) {
  const r = spawnSync('git', args, { cwd: RAIZ, encoding: 'utf8' });
  return { ok: r.status === 0, saida: (r.stdout || '').trim() };
}

function repositorioRaso() {
  return git(['rev-parse', '--is-shallow-repository']).saida !== 'false';
}

function commitExiste(hash) {
  return git(['cat-file', '-e', `${hash}^{commit}`]).ok;
}

function arquivoNoCommit(hash, arquivo) {
  return git(['cat-file', '-e', `${hash}:${arquivo}`]).ok;
}

function ehAncestral(hash) {
  return git(['merge-base', '--is-ancestor', hash, 'HEAD']).ok;
}

// Declaração `test('nome'` / `test("nome"` / `it(...)` com o nome exato, sem pular.
function declaracaoDoTeste(fonte, nome) {
  const re = new RegExp(`(?:^|\\s)(?:test|it)\\(\\s*['"\`]${nome}['"\`]\\s*(,|\\))`, 'm');
  return re.test(fonte);
}

const PADRAO_PULO = /\b(?:test|it|describe)\.(?:skip|todo)\b|\{\s*(?:skip|todo)\s*:|\bt\.(?:skip|todo)\s*\(|\bdescribeAvailable\b.*skip/;

// `{ skip: SKIP }` com SKIP vindo de aiHttpEnv só pula fora do banco descartável (concorrência exige superusuário); no banco descartável nada
// é pulado, o que a execução das donas prova (relatório "pulados 0"). Qualquer outro skip/todo reprova.
function temPulo(fonte) {
  const semCondicional = /require\(['"]\.\.\/_helpers\/aiHttpEnv['"]\)/.test(fonte) ? fonte.replace(/\{\s*skip:\s*SKIP\s*\}/g, '{}') : fonte;
  return PADRAO_PULO.test(semCondicional);
}

module.exports = {
  temPulo,
  RAIZ, NOMES_DO_LIVRO, lerManifesto, lerFonte, repositorioRaso, commitExiste, arquivoNoCommit, ehAncestral, declaracaoDoTeste, PADRAO_PULO,
};
