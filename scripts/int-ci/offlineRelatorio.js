#!/usr/bin/env node
'use strict';

/**
 * Consolida a execução offline da suíte (M9-D258): lê os JUnit gravados pelas etapas da esteira (reports/int-ci/*.xml) e o registro de conexões externas (chamadas-externas.log) e grava
 * reports/offline-run.json: { escopo, geradoEm, totais, chamadasExternas, arquivos: { '<teste>.test.js': [[nome, 'pass'|'fail'|'skip'], ...] } }. A autochecagem (integrationAutocheck.js)
 * lê esse relatório: o "verde" dela é o que está aqui. Sem JUnit nenhum sai com 1 (não existe execução para relatar). Caminhos sempre relativos ao repositório.
 * Uso: node scripts/int-ci/offlineRelatorio.js [--entrada reports/int-ci] [--saida reports/offline-run.json] [--escopo integracoes]
 */
const fs = require('node:fs');
const path = require('node:path');
const { casosDoJunit } = require('./lib/junit');

const RAIZ = path.resolve(__dirname, '..', '..');
const argv = process.argv.slice(2);
const arg = (nome, padrao) => { const i = argv.indexOf(nome); return i >= 0 && argv[i + 1] ? argv[i + 1] : padrao; };

function consolidar(entrada, escopo) {
  const xmls = fs.existsSync(entrada) ? fs.readdirSync(entrada).filter((f) => f.endsWith('.xml')).sort() : [];
  if (!xmls.length) return null;
  const arquivos = {};
  for (const f of xmls) {
    for (const c of casosDoJunit(fs.readFileSync(path.join(entrada, f), 'utf8'))) {
      const rel = path.isAbsolute(c.arquivo) ? path.relative(RAIZ, c.arquivo).split(path.sep).join('/') : c.arquivo;
      (arquivos[rel] = arquivos[rel] || []).push([c.nome, c.status]);
    }
  }
  const log = path.join(entrada, 'chamadas-externas.log');
  const chamadasExternas = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).length : 0;
  const todos = Object.values(arquivos).flat();
  const conta = (s) => todos.filter(([, st]) => st === s).length;
  return { escopo, geradoEm: new Date().toISOString(), totais: { testes: todos.length, passaram: conta('pass'), falharam: conta('fail'), puladas: conta('skip') }, chamadasExternas, arquivos };
}

const entrada = path.resolve(RAIZ, arg('--entrada', 'reports/int-ci'));
const saida = path.resolve(RAIZ, arg('--saida', 'reports/offline-run.json'));
const r = consolidar(entrada, arg('--escopo', 'integracoes'));
if (!r) { console.error(`sem JUnit em ${path.relative(RAIZ, entrada)}: rode as etapas de teste da esteira antes`); process.exit(1); }
fs.mkdirSync(path.dirname(saida), { recursive: true });
fs.writeFileSync(saida, `${JSON.stringify(r)}\n`);
console.log(`${path.relative(RAIZ, saida)}: ${r.totais.testes} testes em ${Object.keys(r.arquivos).length} arquivos (${r.totais.passaram} passaram, ${r.totais.falharam} falharam, ${r.totais.puladas} puladas), ${r.chamadasExternas} chamadas externas`);
