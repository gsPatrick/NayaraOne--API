#!/usr/bin/env node
'use strict';
/**
 * Lint do contrato OpenAPI (M9-D840). Não lê banco.
 *   npm run lint:openapi -- --base <arquivo|ref git> --candidate openapi/openapi.v1.yaml [--scope openapi/escopo.json] [--error-codes docs/ERROR_CODES.md] [--routes-file rotas.json] [--json] [--report saida.json]
 * Saída: 0 ok; 1 mudança incompatível na mesma major ou rota do escopo sem documentação; 2 contrato inválido. Sem --routes-file, as rotas reais vêm de src/routes.
 */
process.env.PORT = process.env.PORT || '0';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { lintContracts } = require('../src/features/core-governance/api-governance/openapi/lint.service');
const { EXIT } = require('../src/features/core-governance/api-governance/openapi/openapi.errors');

function args(argv) {
  const out = { json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (key === '--json') out.json = true;
    else if (key.startsWith('--')) { out[key.slice(2)] = argv[i + 1]; i += 1; }
  }
  return out;
}

const git = (...params) => execFileSync('git', params, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });

/** Base: arquivo existente ou ref git (lê o mesmo caminho do candidato naquele ref; o ref sem o arquivo = primeiro contrato). */
function readBase(base, candidate) {
  if (!base) return null;
  if (fs.existsSync(base)) return fs.readFileSync(base, 'utf8');
  try { git('rev-parse', '--verify', `${base}^{commit}`); } catch (_e) { throw Object.assign(new Error(`A base "${base}" não é um arquivo nem uma referência git.`), { invalidBase: true }); }
  const relative = path.relative(process.cwd(), path.resolve(candidate)).split(path.sep).join('/');
  try { return git('show', `${base}:${relative}`); } catch (_e) { return null; }
}

function main() {
  const a = args(process.argv.slice(2));
  const candidate = a.candidate || 'openapi/openapi.v1.yaml';
  let report;
  try {
    const scopePath = a.scope || 'openapi/escopo.json';
    const catalogPath = a['error-codes'] || (fs.existsSync('docs/ERROR_CODES.md') ? 'docs/ERROR_CODES.md' : null);
    const routes = a['routes-file'] ? JSON.parse(fs.readFileSync(a['routes-file'], 'utf8')) : require('./gerarMatrizPermissoes').gerar().map((r) => ({ method: r.method, path: r.path }));
    report = lintContracts({
      baseText: readBase(a.base, candidate), candidateText: fs.readFileSync(candidate, 'utf8'), candidatePath: path.resolve(candidate), routes,
      scopeJson: fs.readFileSync(scopePath, 'utf8'), errorCatalogText: catalogPath ? fs.readFileSync(catalogPath, 'utf8') : null,
    });
  } catch (err) {
    const code = err.code && String(err.code).startsWith('GOV_') ? err.code : 'GOV_OPENAPI_INVALID';
    const message = err.invalidBase ? `O contrato OpenAPI é inválido: ${err.message}` : err.message;
    report = { exitCode: EXIT.INVALID, ok: false, changes: [], undocumented: [], error: { code, message }, text: `${code} ${message}` };
  }
  if (a.report) fs.writeFileSync(a.report, `${JSON.stringify({ ...report, text: undefined }, null, 2)}\n`);
  console.log(a.json ? JSON.stringify({ ...report, text: undefined }, null, 2) : report.text);
  process.exit(report.exitCode);
}

main();
