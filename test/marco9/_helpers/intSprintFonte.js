'use strict';

/**
 * M9-D255 — fábrica de uma pasta de demandas falsa (marco-9/*.md) com a M9-D255 (tabelas dos passos, dos transversais e dos sprints I1 a I9) e o
 * status/dependências de cada demanda. É o que scripts/integrationSprintGate.js lê. Devolve a pasta (tmp) e `limpar()`.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SPRINTS = { I1: ['D200', 'D201'], I2: ['D206', 'D215'], I3: ['D211'] };
const PASSOS = [{ n: 1, nome: 'registry', ids: 'D200, D201' }, { n: 2, nome: 'retry', ids: 'D206 a D206, D215' }, { n: 3, nome: 'webhooks', ids: 'D211' }];

const completo = (d) => `M9-${d}`;

function textoD255({ sprints = SPRINTS, passos = PASSOS, transversais = 'D211' } = {}) {
  const ps = passos.map((p) => `| ${p.n} | ${p.nome} | ${p.ids} |`).join('\n');
  const ss = Object.entries(sprints).map(([cod, ids]) => `| ${cod} | tema ${cod} | ${ids.join(', ')} | portão ${cod} |`).join('\n');
  return `\n## 3. Regras\n| Passo | Conteúdo | Demandas |\n|---|---|---|\n${ps}\nTransversais de segurança e administração: ${transversais}.\n| Sprint | Escopo | Demandas | Portão de saída |\n|---|---|---|---|\n${ss}\n`;
}

function corpo(id, { status = 'aberta', deps = [] }, extra = '') {
  return `# ${id} — título de ${id}\n\n| Campo | Valor |\n|---|---|\n| Marco | 9 |\n| Dependências | ${deps.join(';') || 'nenhuma'} |\n| Status | ${status} |\n\n## 1. Origem\nx\n${extra}`;
}

/** `status`/`deps` por id curto (D200). `extras`: demandas do bloco que existem como arquivo mas não estão na tabela. */
function montarFonte({ sprints = SPRINTS, passos = PASSOS, status = {}, deps = {}, extras = [], transversais } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm9d255-fonte-'));
  const pasta = path.join(dir, 'marco-9');
  fs.mkdirSync(pasta, { recursive: true });
  const ids = new Set([...Object.values(sprints).flat(), ...passos.flatMap((p) => p.ids.match(/D\d{3}/g)), ...extras]);
  for (const id of ids) fs.writeFileSync(path.join(pasta, `${completo(id)}-x.md`), corpo(completo(id), { status: status[id], deps: (deps[id] || []).map(completo) }));
  fs.writeFileSync(path.join(pasta, 'M9-D255-x.md'), corpo('M9-D255', { status: 'em_execucao' }, textoD255({ sprints, passos, transversais })));
  return { dir, limpar: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

module.exports = { montarFonte, SPRINTS, PASSOS };
