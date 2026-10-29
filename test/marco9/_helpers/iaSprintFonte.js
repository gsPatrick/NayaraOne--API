'use strict';

/**
 * M9-D045 — fábrica de uma pasta de demandas falsa (marco-9/*.md) com a M9-D045 (tabelas dos 12 passos, dos transversais e dos sprints) e o
 * status/dependências de cada demanda. É o que scripts/ai-sprint-gate.js lê. Devolve a pasta (tmp) e `limpar()`.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SPRINTS = { AI1: ['D001', 'D010'], AI2: ['D006', 'D020'], AI3: ['D022', 'D023'], AI4: ['D024'] };
const PASSOS = [{ n: 1, nome: 'AIProviderAdapter/registry', ids: 'D010' }, { n: 2, nome: 'ai_runs/sources', ids: 'D001' }, { n: 3, nome: 'tool registry', ids: 'D006, D020' }, { n: 4, nome: 'RAG', ids: 'D022 a D023, D024' }];

const completo = (d) => `M9-${d}`;

function textoD045({ sprints = SPRINTS, passos = PASSOS, transversais = 'D001' } = {}) {
  const ps = passos.map((p) => `| ${p.n} | ${p.nome} | ${p.ids} |`).join('\n');
  const ss = Object.entries(sprints).map(([cod, ids]) => `| ${cod} | tema ${cod} | ${ids.join(', ')} | portão ${cod} |`).join('\n');
  return `\n## 3. Regras\n| Passo | Livro | Demandas |\n|---|---|---|\n${ps}\nTransversais a todos os passos: ${transversais}.\n**Os 10 sprints:**\n| Sprint | Tema do livro | Demandas (entrega) | Portão de saída |\n|---|---|---|---|\n${ss}\n`;
}

function corpo(id, { status = 'aberta', deps = [] }, extra = '') {
  return `# ${id} — título de ${id}\n\n| Campo | Valor |\n|---|---|\n| Marco | 9 |\n| Dependências | ${deps.join(';') || 'nenhuma'} |\n| Status | ${status} |\n\n## 1. Origem\nx\n${extra}`;
}

/** `status`/`deps` por id curto (D001). `extras`: demandas do bloco A que existem como arquivo mas não estão na tabela. */
function montarFonte({ sprints = SPRINTS, passos = PASSOS, status = {}, deps = {}, extras = [], transversais } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm9d045-fonte-'));
  const pasta = path.join(dir, 'marco-9');
  fs.mkdirSync(pasta, { recursive: true });
  const ids = new Set([...Object.values(sprints).flat(), ...passos.flatMap((p) => p.ids.match(/D\d{3}/g)), ...extras]);
  for (const id of ids) {
    fs.writeFileSync(path.join(pasta, `${completo(id)}-x.md`), corpo(completo(id), { status: status[id], deps: (deps[id] || []).map(completo) }));
  }
  fs.writeFileSync(path.join(pasta, 'M9-D045-x.md'), corpo('M9-D045', { status: 'em_execucao' }, textoD045({ sprints, passos, transversais })));
  return { dir, limpar: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

/** Árvore de testes falsa (`<raiz>/test/...`) com um teste por título em arquivos distintos. */
function montarTestes(titulos) {
  const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'm9d045-testes-'));
  fs.mkdirSync(path.join(raiz, 'test'), { recursive: true });
  titulos.forEach((t, i) => fs.writeFileSync(path.join(raiz, 'test', `t${i}.test.js`), `test('${t}', () => {});\n`));
  return { raiz, limpar: () => fs.rmSync(raiz, { recursive: true, force: true }) };
}

module.exports = { montarFonte, montarTestes, SPRINTS, PASSOS };
