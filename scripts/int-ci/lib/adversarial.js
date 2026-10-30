'use strict';

/**
 * Verificador dos testes adversariais das integrações (M9-D251, Guia §19 e §20). O manifesto lista os 15 itens do livro e os 18 nomes de teste; o verificador confere que a lista
 * é a do livro (15 itens numerados de 1 a 15, 18 nomes únicos) e que cada nome existe como `test('<nome>'` em algum arquivo de teste. Nome ausente: código
 * INTEGRATION_ADVERSARIAL_NAME_MISSING. Quem chama decide a saída (o script sai com 1).
 */
const fs = require('node:fs');
const path = require('node:path');

const RAIZ = path.join(__dirname, '..', '..', '..');
const MANIFESTO_PADRAO = path.join(__dirname, '..', 'adversarial-manifest-int.json');
const CODIGO_AUSENTE = 'INTEGRATION_ADVERSARIAL_NAME_MISSING';
const MENSAGEM_AUSENTE = 'Teste adversarial obrigatório ausente.';
const ITENS_DO_LIVRO = 15;
const NOMES_ESPERADOS = 18;

function arquivosDeTeste(dir, acc = []) {
  if (!fs.existsSync(dir)) return acc;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules') arquivosDeTeste(p, acc); } else if (/\.test\.js$/.test(e.name)) acc.push(p);
  }
  return acc;
}

const nomesDeclarados = (texto) => new Set([...texto.matchAll(/\b(?:test|it)\(\s*['"`]([^'"`]+)['"`]/g)].map((m) => m[1]));

/** Problemas da estrutura do manifesto (vazio = coerente com o livro): 15 itens numerados, 18 nomes únicos com o prefixo adv_. */
function problemasDoManifesto(manifesto) {
  const problemas = [];
  const itens = Array.isArray(manifesto && manifesto.itens) ? manifesto.itens : [];
  if (itens.length !== ITENS_DO_LIVRO) problemas.push(`o manifesto lista ${itens.length} itens; o livro tem ${ITENS_DO_LIVRO}`);
  itens.forEach((it, i) => { if (it.n !== i + 1) problemas.push(`o item na posição ${i + 1} está numerado ${it.n}`); if (!Array.isArray(it.testes) || !it.testes.length) problemas.push(`o item ${it.n} não tem teste`); });
  const nomes = itens.flatMap((it) => it.testes || []);
  if (nomes.length !== NOMES_ESPERADOS) problemas.push(`o manifesto lista ${nomes.length} nomes de teste; a regra são ${NOMES_ESPERADOS}`);
  if (new Set(nomes).size !== nomes.length) problemas.push('há nome de teste repetido no manifesto');
  nomes.filter((n) => !/^adv_[a-z0-9_]+$/.test(n)).forEach((n) => problemas.push(`o nome "${n}" não segue o padrão adv_<minúsculas>`));
  return problemas;
}

/**
 * verificarNomes({ manifesto, raizes, ate_parte }) — `manifesto`: caminho do JSON; `raizes`: pastas de teste; `ateParte`: confere só os nomes até aquela parte (a esteira usa tudo).
 * Devolve { ok, problemas, ausentes: [{ nome, item, parte }], total, itens }.
 */
function verificarNomes({ manifesto = MANIFESTO_PADRAO, raizes = [path.join(RAIZ, 'test')], ateParte = null } = {}) {
  const dados = JSON.parse(fs.readFileSync(manifesto, 'utf8'));
  const problemas = problemasDoManifesto(dados);
  const achados = new Set();
  for (const raiz of raizes) for (const arq of arquivosDeTeste(raiz)) nomesDeclarados(fs.readFileSync(arq, 'utf8')).forEach((n) => achados.add(n));
  const ausentes = [];
  let total = 0;
  for (const it of dados.itens || []) {
    if (ateParte && it.parte > ateParte) continue;
    for (const nome of it.testes || []) { total += 1; if (!achados.has(nome)) ausentes.push({ nome, item: it.n, parte: it.parte }); }
  }
  return { ok: problemas.length === 0 && ausentes.length === 0, problemas, ausentes, total, itens: (dados.itens || []).length };
}

module.exports = { verificarNomes, problemasDoManifesto, nomesDeclarados, CODIGO_AUSENTE, MENSAGEM_AUSENTE, MANIFESTO_PADRAO };
