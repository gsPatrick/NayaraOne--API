'use strict';

/**
 * Mapa dos 10 testes adversariais do bloco de governança (M9-D890, Caderno §11). O mapa (docs/governance/adversarial-map.json) lista as frases do livro e o NOME EXATO do teste
 * de cada uma. A verificação procura a declaração `test('<nome>'` / `it('<nome>'` nos arquivos de teste (API e Front) e reprova o nome ausente e o nome declarado com skip ou todo
 * (opção `{ skip }`/`{ todo }` ou modificador `.skip`/`.todo`). Erro de leitura não vira "ok": quem chama sai com 2.
 * Exceção declarada: com CI_SEM_REPOS_IRMAOS=1 (CI que só tem a API) uma raiz de teste que mora num repositório irmão (começa por ../) e não existe é dispensada, e os nomes do mapa
 * listados em `nomes_no_front` (os que só existem lá) saem como `naoAplicaveis` (NÃO verificados, ditos como tais), nunca como presentes. Nome fora dessa lista continua exigido na API.
 */
const fs = require('node:fs');
const path = require('node:path');

const RAIZ_API = path.join(__dirname, '..', '..');
const MAPA_PADRAO = path.join(RAIZ_API, 'docs', 'governance', 'adversarial-map.json');
const CODIGO_AUSENTE = 'GOV_ADVERSARIAL_MISSING';
const MENSAGEM_AUSENTE = 'Teste adversarial do livro ausente:';
const ITENS_DO_LIVRO = 10;
const JANELA_OPCOES = 200;
const EXTENSOES = /\.test\.(?:js|mjs)$/;

class LeituraError extends Error {}

function arquivosDeTeste(dir, acc = []) {
  let entradas;
  try { entradas = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { throw new LeituraError(`não foi possível ler a pasta de testes ${dir}: ${e.code || e.message}`); }
  for (const e of entradas) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules') arquivosDeTeste(p, acc); } else if (EXTENSOES.test(e.name)) acc.push(p);
  }
  return acc;
}

const escapar = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Declarações do nome no texto: [{ ignorado: boolean }]. O título declarado começa pelo nome do mapa (o nome pode ser seguido de detalhe depois de espaço, dois-pontos ou vírgula).
 * Ignorado = modificador `.skip`/`.todo`, opção `todo`, ou `skip` estático (`skip: true` ou texto literal). `skip: skip()` / `http.skip` é pulo condicional à falta de banco: vale como ativo
 * aqui, e a etapa de CI reprova qualquer teste pulado no banco descartável (scripts/ci-governanca.sh). Janela depois do título: até o `=>` ou `function` que abre o corpo.
 */
function declaracoes(texto, nome) {
  const re = new RegExp(`\\b(?:test|it)((?:\\.[a-z]+)?)\\(\\s*(['"\`])${escapar(nome)}(?![\\p{L}\\p{N}_])`, 'gu');
  const achadas = [];
  let m;
  while ((m = re.exec(texto))) {
    const depois = texto.slice(re.lastIndex, re.lastIndex + JANELA_OPCOES);
    const fimTitulo = depois.search(/['"`]/);
    const aposTitulo = fimTitulo === -1 ? '' : depois.slice(fimTitulo + 1);
    const corte = aposTitulo.search(/=>|\bfunction\b/);
    const opcoes = corte === -1 ? aposTitulo : aposTitulo.slice(0, corte);
    const estatico = /\bskip\s*:\s*(?:true\b|['"`])/.test(opcoes) || /\btodo\b/.test(opcoes);
    achadas.push({ ignorado: /^\.(?:skip|todo)$/.test(m[1]) || estatico });
  }
  return achadas;
}

/** Problemas da estrutura do mapa (vazio = coerente com o livro): 10 itens (ou `itens_do_livro`) numerados de 1 a 10, cada um com ao menos um teste, nomes únicos. */
function problemasDoMapa(mapa) {
  const problemas = [];
  const itens = Array.isArray(mapa && mapa.itens) ? mapa.itens : [];
  const esperados = Number.isInteger(mapa && mapa.itens_do_livro) ? mapa.itens_do_livro : ITENS_DO_LIVRO; // o mapa do bloco F (M9-D940) declara os 9 testes dele
  if (itens.length !== esperados) problemas.push(`o mapa lista ${itens.length} itens; o livro tem ${esperados}`);
  itens.forEach((it, i) => {
    if (it.n !== i + 1) problemas.push(`o item na posição ${i + 1} está numerado ${it.n}`);
    if (!Array.isArray(it.testes) || !it.testes.length) problemas.push(`o item ${it.n} não tem teste`);
  });
  const nomes = itens.flatMap((it) => it.testes || []);
  if (new Set(nomes).size !== nomes.length) problemas.push('há nome de teste repetido no mapa');
  return problemas;
}

function lerMapa(arquivo) {
  try { return JSON.parse(fs.readFileSync(arquivo, 'utf8')); } catch (e) { throw new LeituraError(`não foi possível ler o mapa ${arquivo}: ${e.code || e.message}`); }
}

/**
 * verificarMapa({ mapa, raizes }) — `mapa`: caminho do JSON; `raizes`: pastas de teste (padrão: as do próprio mapa, relativas à raiz da API).
 * Devolve { ok, problemas, ausentes: [{ nome, item, demanda, motivo }], total, itens }. Lança LeituraError se algo não puder ser lido.
 */
function verificarMapa({ mapa = MAPA_PADRAO, raizes = null } = {}) {
  const dados = lerMapa(mapa);
  const todasAsPastas = raizes || (dados.raizes || ['test']).map((r) => path.resolve(RAIZ_API, r));
  const declarado = process.env.CI_SEM_REPOS_IRMAOS === '1' && !raizes;
  const dispensadas = declarado ? (dados.raizes || ['test']).filter((r) => r.startsWith('../') && !fs.existsSync(path.resolve(RAIZ_API, r))) : [];
  const pastas = todasAsPastas.filter((p) => !dispensadas.some((r) => path.resolve(RAIZ_API, r) === p));
  const textos = pastas.flatMap((p) => arquivosDeTeste(p)).map((arq) => {
    try { return fs.readFileSync(arq, 'utf8'); } catch (e) { throw new LeituraError(`não foi possível ler ${arq}: ${e.code || e.message}`); }
  });
  const problemas = problemasDoMapa(dados);
  const ausentes = [];
  const naoAplicaveis = [];
  const soNoFront = new Set(dispensadas.length ? dados.nomes_no_front || [] : []);
  let total = 0;
  for (const it of dados.itens || []) {
    for (const nome of it.testes || []) {
      total += 1;
      const achadas = textos.flatMap((t) => declaracoes(t, nome));
      if (!achadas.length && soNoFront.has(nome)) naoAplicaveis.push({ nome, item: it.n, demanda: it.demanda, raizes: dispensadas });
      else if (!achadas.length) ausentes.push({ nome, item: it.n, demanda: it.demanda, motivo: 'ausente' });
      else if (achadas.every((a) => a.ignorado)) ausentes.push({ nome, item: it.n, demanda: it.demanda, motivo: 'skip ou todo' });
    }
  }
  return { ok: problemas.length === 0 && ausentes.length === 0, problemas, ausentes, naoAplicaveis, total, itens: (dados.itens || []).length };
}

module.exports = { verificarMapa, problemasDoMapa, declaracoes, LeituraError, MAPA_PADRAO, CODIGO_AUSENTE, MENSAGEM_AUSENTE, ITENS_DO_LIVRO };
