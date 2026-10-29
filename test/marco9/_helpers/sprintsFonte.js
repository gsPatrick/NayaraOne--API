'use strict';

/**
 * M9-D706/M9-D707 — fábrica de uma pasta de demandas falsa (marco-9/*.md) com o mapa de sprints da M9-D706 e o status/dependências de cada
 * demanda. Só o cabeçalho e a tabela 3.1 existem; é o que os scripts de portão leem. Devolve a pasta (tmp) e `limpar()`.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SPRINTS_PADRAO = {
  B1: ['M9-D600', 'M9-D601'], B2: ['M9-D615'], B3: ['M9-D616'], B4: ['M9-D618'], B5: ['M9-D619'],
  B6: ['M9-D627'], B7: ['M9-D691'], B8: ['M9-D693'], B9: ['M9-D706'],
};

function tabela(sprints) {
  const linhas = Object.entries(sprints).map(([cod, ids]) => `| ${cod} | escopo ${cod} | ${ids.map((i, k) => (k ? i.slice(3) : i)).join(', ')} | portão ${cod} |`);
  return ['| Sprint | Escopo (livro) | Demandas | Portão de saída |', '|---|---|---|---|', ...linhas].join('\n');
}

function corpo(id, { status = 'aberta', deps = [] }, extra = '') {
  return `# ${id} — título de ${id}\n\n| Campo | Valor |\n|---|---|\n| Marco | 9 |\n| Dependências | ${deps.join(';') || 'nenhuma'} |\n| Status | ${status} |\n\n## 1. Origem\nx\n${extra}`;
}

function montarFonte({ sprints = SPRINTS_PADRAO, status = {}, deps = {}, extras = [] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm9d706-fonte-'));
  const pasta = path.join(dir, 'marco-9');
  fs.mkdirSync(pasta, { recursive: true });
  const ids = new Set([...Object.values(sprints).flat(), ...extras]);
  for (const id of ids) {
    const extra = id === 'M9-D706' ? `\n## 3. Regras\n### 3.1 Mapa sprint → demandas → portão de saída\n${tabela(sprints)}\n` : '';
    fs.writeFileSync(path.join(pasta, `${id}-x.md`), corpo(id, { status: status[id], deps: deps[id] }, extra));
  }
  return { dir, limpar: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

module.exports = { SPRINTS_PADRAO, montarFonte, tabela };
