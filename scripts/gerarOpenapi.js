#!/usr/bin/env node
'use strict';
/**
 * Gera o esqueleto do contrato a partir das rotas reais do escopo (M9-D840 §3.1).
 *   node scripts/gerarOpenapi.js                -> imprime YAML
 *   node scripts/gerarOpenapi.js --write        -> grava openapi/openapi.v1.yaml (só se ainda não existir)
 *   node scripts/gerarOpenapi.js --missing      -> imprime só as operações que faltam no arquivo versionado
 */
process.env.PORT = process.env.PORT || '0';
const fs = require('node:fs');
const { gerar } = require('./gerarMatrizPermissoes');
const { buildSkeleton, toYaml } = require('../src/features/core-governance/api-governance/openapi/skeleton');
const { parseScope } = require('../src/features/core-governance/api-governance/openapi/scope');

const FILE = 'openapi/openapi.v1.yaml';
const entries = parseScope(fs.readFileSync('openapi/escopo.json', 'utf8'));
const doc = buildSkeleton(gerar(), entries);

if (process.argv.includes('--write')) {
  if (fs.existsSync(FILE)) { console.error(`${FILE} já existe: edite-o (o contrato versionado é a fonte), ou use --missing.`); process.exit(1); }
  fs.writeFileSync(FILE, toYaml(doc));
  console.log(`${FILE} gravado com ${Object.keys(doc.paths).length} caminhos.`);
} else if (process.argv.includes('--missing')) {
  const have = require('js-yaml').load(fs.readFileSync(FILE, 'utf8'));
  const missing = {};
  for (const [path, item] of Object.entries(doc.paths)) for (const [method, op] of Object.entries(item)) if (!(have.paths[path] && have.paths[path][method])) { missing[path] = missing[path] || {}; missing[path][method] = op; }
  console.log(toYaml({ paths: missing }));
} else console.log(toYaml(doc));
