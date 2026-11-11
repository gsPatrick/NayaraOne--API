#!/usr/bin/env node
'use strict';

/**
 * M4-D140 (regra 10 g/h): grava os dois retratos tirados ANTES da reorganização do Financeiro para
 * src/modules/finance, que o teste de estrutura usa para provar que nada mudou na mudança de pasta:
 *   test/fixtures/m4d140-sequelize-meta-financeiro.json  nomes (= linhas da SequelizeMeta) das migrations financeiras
 *   test/fixtures/m4d140-rotas-http.json                  método, caminho, permissões, MFA e cadeia de cada rota /finance
 * Uso: node scripts/m4d140/gerarSnapshots.js  (sem banco; só lê arquivos e monta o roteador).
 * Rodar de novo depois da mudança produz os mesmos nomes e rotas: as migrations financeiras são procuradas na raiz
 * (pelo critério de scripts/lib/financeMigrations.js) e na pasta do módulo.
 */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { isFinanceMigration } = require('../lib/financeMigrations');
const { mapaDeRotasDoFinanceiro } = require('../lib/financeRoutesMap');

const API = path.resolve(__dirname, '..', '..');
const RAIZ = path.join(API, 'migrations');
const DO_MODULO = path.join(API, 'src', 'modules', 'finance', 'infrastructure', 'db', 'migrations');

const js = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.js')) : []);

function migrationsFinanceiras() {
  const naRaiz = js(RAIZ).filter((f) => isFinanceMigration(fs.readFileSync(path.join(RAIZ, f), 'utf8')));
  return [...new Set([...naRaiz, ...js(DO_MODULO)])].sort();
}

function commitAtual() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: API, encoding: 'utf8' }).trim();
  } catch (_e) {
    return 'desconhecido';
  }
}

function gravar(nome, conteudo) {
  const destino = path.join(API, 'test', 'fixtures', nome);
  fs.mkdirSync(path.dirname(destino), { recursive: true });
  fs.writeFileSync(destino, `${JSON.stringify(conteudo, null, 2)}\n`);
  return destino;
}

if (require.main === module) {
  const base = { demanda: 'M4-D140', geradoNoCommit: commitAtual() };
  const nomes = migrationsFinanceiras();
  const rotas = mapaDeRotasDoFinanceiro();
  gravar('m4d140-sequelize-meta-financeiro.json', {
    ...base,
    criterio: 'scripts/lib/financeMigrations.js#isFinanceMigration (cria, altera ou concede acesso a objeto do schema finance)',
    total: nomes.length,
    nomes,
  });
  gravar('m4d140-rotas-http.json', { ...base, total: rotas.length, rotas });
  console.log(`migrations financeiras: ${nomes.length}; rotas HTTP do Financeiro: ${rotas.length}`);
  process.exit(0);
}

module.exports = { migrationsFinanceiras };
