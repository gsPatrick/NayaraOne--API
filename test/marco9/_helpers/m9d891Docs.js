'use strict';

// Leitura dos documentos de governança para os testes de conteúdo da M9-D891 (READMEs, runbooks, ADR). Sem banco.
const fs = require('node:fs');
const path = require('node:path');

const RAIZ = path.join(__dirname, '..', '..', '..');
const GOV = path.join(RAIZ, 'src', 'features', 'core-governance');
const RUNBOOKS = path.join(RAIZ, 'docs', 'runbooks', 'governance');
const ADR = path.join(RAIZ, 'docs', 'governance', 'adr');

/** Módulo = pasta, segmento do prefixo `governanca.<segmento>.` e o runbook que o opera. */
const MODULOS = Object.freeze([
  { pasta: 'calendar', segmentos: ['calendario'], runbook: 'calendario.md' },
  { pasta: 'data-quality', segmentos: ['dados', 'retencao'], runbook: 'dados-mestres.md' },
  { pasta: 'lineage', segmentos: ['lineage'], runbook: 'lineage.md' },
  { pasta: 'dlp', segmentos: ['dlp'], runbook: 'dlp.md' },
  { pasta: 'bcp', segmentos: ['bcp'], runbook: 'bcp.md' },
  { pasta: 'api-governance', segmentos: ['api'], runbook: 'api-governance.md' },
  { pasta: 'finops', segmentos: ['finops'], runbook: 'finops.md' },
  { pasta: 'feature-flags', segmentos: ['flags'], runbook: 'flags.md' },
]);

const SECOES = Object.freeze(['Objetivo', 'Tabelas', 'Rotas e permissões', 'Eventos', 'Jobs e horários', 'Parâmetros', 'Decisões (ADR)', 'Como testar', 'Como diagnosticar']);

const ler = (arquivo) => fs.readFileSync(arquivo, 'utf8');

function arquivosJs(dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) arquivosJs(p, acc); else if (e.name.endsWith('.js')) acc.push(p);
  }
  return acc;
}

/** Chaves `governanca.*` escritas como texto no código do módulo (pasta inteira). */
function chavesNoCodigo(pasta) {
  const chaves = new Set();
  for (const arq of arquivosJs(path.join(GOV, pasta))) for (const m of ler(arq).matchAll(/['"`](governanca\.[a-z0-9_.]*[a-z0-9_])/g)) chaves.add(m[1]);
  return chaves;
}

/** Corpo de cada seção `## Título` (até o próximo `## `), por título. */
function secoes(markdown) {
  const mapa = new Map();
  let atual = null;
  for (const linha of markdown.split('\n')) {
    const h = linha.match(/^## (.+?)\s*$/);
    if (h) { atual = h[1]; mapa.set(atual, []); } else if (atual) mapa.get(atual).push(linha);
  }
  return new Map([...mapa].map(([t, l]) => [t, l.join('\n').trim()]));
}

const documentos = () => [
  ...MODULOS.map((m) => path.join(GOV, m.pasta, 'README.md')),
  path.join(GOV, 'README.md'),
  ...fs.readdirSync(RUNBOOKS).filter((f) => f.endsWith('.md')).map((f) => path.join(RUNBOOKS, f)),
  ...fs.readdirSync(ADR).filter((f) => f.endsWith('.md')).map((f) => path.join(ADR, f)),
  path.join(RAIZ, 'docs', 'governance', 'teste-do-novato.md'),
];

module.exports = { RAIZ, GOV, RUNBOOKS, ADR, MODULOS, SECOES, ler, chavesNoCodigo, secoes, documentos };
