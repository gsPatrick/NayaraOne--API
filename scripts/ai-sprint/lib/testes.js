'use strict';

/**
 * M9-D045 — localiza e executa os testes que o portão de um sprint exige. Exigência de teste = `{ nome }` (o teste com esse título, em
 * qualquer arquivo de test/) ou `{ arquivos: [glob] }` (todos os testes dos arquivos). "Ausente" = o título não aparece em nenhum arquivo
 * de teste (ou o glob não casa com arquivo). "Vermelho" = a execução (node --test, relatório TAP) reprova ou pula o teste.
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const RAIZ = path.join(__dirname, '..', '..', '..');
const escapar = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function arquivosDeTeste(raiz = RAIZ) {
  const saida = [];
  const andar = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) andar(p); else if (e.name.endsWith('.test.js')) saida.push(p);
    }
  };
  const base = path.join(raiz, 'test');
  if (fs.existsSync(base)) andar(base);
  return saida.sort();
}

const globParaRegex = (g) => new RegExp(`^${g.split('*').map(escapar).join('[^/]*')}$`);

/** Arquivos (relativos à raiz) que declaram o teste de título `nome` com test/it/describe. */
function arquivosComTeste(nome, todos, raiz = RAIZ) {
  const re = new RegExp(`\\b(?:test|it|describe)\\s*\\(\\s*(['"\`])${escapar(nome)}\\1`);
  return todos.filter((f) => re.test(fs.readFileSync(f, 'utf8'))).map((f) => path.relative(raiz, f));
}

function arquivosDoGlob(glob, todos, raiz = RAIZ) {
  const re = globParaRegex(glob);
  return todos.map((f) => path.relative(raiz, f)).filter((rel) => re.test(rel));
}

/** Resolve as exigências em arquivos: [{ tipo, rotulo, nome?, arquivos, ausente }]. */
function resolver(exigencias, raiz = RAIZ) {
  const todos = arquivosDeTeste(raiz);
  return exigencias.map((ex) => {
    if (ex.nome) {
      const arquivos = arquivosComTeste(ex.nome, todos, raiz);
      return { tipo: 'nome', rotulo: ex.nome, nome: ex.nome, arquivos, ausente: arquivos.length === 0 };
    }
    const arquivos = Array.from(new Set(ex.arquivos.flatMap((g) => arquivosDoGlob(g, todos, raiz))));
    return { tipo: 'arquivos', rotulo: ex.arquivos.join(' + '), arquivos, ausente: arquivos.length === 0 };
  });
}

/** Lê um relatório TAP: { aprovados, reprovados, pulados } (conjuntos de títulos, em qualquer nível de aninhamento). */
function lerTap(texto) {
  const aprovados = new Set();
  const reprovados = new Set();
  const pulados = new Set();
  for (const linha of String(texto).split('\n')) {
    const m = linha.match(/^\s*(not ok|ok)\s+\d+\s+-\s+(.*?)(?:\s+#\s*(SKIP|TODO)\b.*)?$/i);
    if (!m) continue;
    const titulo = m[2].trim();
    if (m[3]) pulados.add(titulo); else if (/^not ok$/i.test(m[1])) reprovados.add(titulo); else aprovados.add(titulo);
  }
  return { aprovados, reprovados, pulados };
}

/** Roda `node --test` nos arquivos (o ambiente do chamador vale: banco descartável, CLAMAV etc.); `nomes` restringe por título. */
function executar(arquivos, { nomes = [], raiz = RAIZ, env = process.env, spawn = spawnSync } = {}) {
  const args = ['--test', '--test-concurrency=1', '--test-reporter=tap'];
  for (const n of nomes) args.push(`--test-name-pattern=^${escapar(n)}$`);
  const r = spawn(process.execPath, [...args, ...arquivos], { cwd: raiz, env: { ...env, NODE_ENV: 'test' }, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  return lerTap(`${r.stdout || ''}\n${r.stderr || ''}`);
}

const semTeste = (t) => ({ aprovados: new Set(), reprovados: new Set(), pulados: new Set(), ...t });

/** Estado de um item contra um TAP: 'verde' | 'vermelho' | 'ausente' | 'nao_executado'. */
function estadoDo(item, tap) {
  if (item.ausente) return 'ausente';
  if (!tap) return 'nao_executado';
  if (item.tipo === 'nome') {
    if (tap.reprovados.has(item.nome) || tap.pulados.has(item.nome)) return 'vermelho';
    return tap.aprovados.has(item.nome) ? 'verde' : 'nao_executado';
  }
  if (tap.reprovados.size || tap.pulados.size) return 'vermelho';
  return tap.aprovados.size ? 'verde' : 'nao_executado';
}

/**
 * Avalia os itens. Sem `rodar`, só a presença ('ausente' ou 'nao_executado'). Com `rodar`, executa: os itens por título num único processo
 * (com os padrões de nome) e cada item por arquivos no seu próprio processo, para um vermelho não contaminar outro item.
 */
function avaliarItens(itens, { rodar = false, ...opcoes } = {}) {
  const nomes = itens.filter((i) => i.tipo === 'nome' && !i.ausente);
  const tapNomes = rodar && nomes.length ? semTeste(executar(Array.from(new Set(nomes.flatMap((i) => i.arquivos))), { ...opcoes, nomes: nomes.map((i) => i.nome) })) : null;
  return itens.map((it) => {
    if (it.tipo === 'nome') return { ...it, estado: estadoDo(it, tapNomes) };
    const tap = rodar && !it.ausente ? semTeste(executar(it.arquivos, opcoes)) : null;
    return { ...it, estado: estadoDo(it, tap) };
  });
}

module.exports = { resolver, executar, lerTap, estadoDo, avaliarItens, arquivosDeTeste, RAIZ };
