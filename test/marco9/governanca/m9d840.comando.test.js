'use strict';

// M9-D840 — o comando `lint:openapi` (saídas 0, 1 e 2), versão maior, cobertura das rotas reais do escopo e o contrato versionado do repositório. Sem banco.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { baseContract, clone, dump, lint, rulesOf, tmpFiles, cli, ROOT } = require('../_helpers/m9d840Contracts');

const SCOPE = { entries: ['/contracts', 'POST /outros'] };
const noRoutes = () => JSON.stringify([]);

test('m9d840 breaking API change detectado pelo comando: exit 1 com a regra e exit 0 com o contrato correto', () => {
  const broken = clone(baseContract());
  delete broken.paths['/contracts/{id}'];
  broken.info.version = '1.5.0';
  const f = tmpFiles({ 'base.yaml': baseContract(), 'cand.yaml': broken, 'ok.yaml': baseContract(), 'escopo.json': JSON.stringify(SCOPE), 'rotas.json': noRoutes() });
  const bad = cli(['--base', f['base.yaml'], '--candidate', f['cand.yaml'], '--scope', f['escopo.json'], '--routes-file', f['rotas.json'], '--json']);
  assert.equal(bad.status, 1, bad.stdout);
  const report = JSON.parse(bad.stdout);
  assert.deepEqual(report.changes.map((c) => [c.code, c.rule]), [['GOV_OPENAPI_BREAKING_CHANGE', 'ROUTE_REMOVED'], ['GOV_OPENAPI_BREAKING_CHANGE', 'ROUTE_REMOVED']], 'GET e PATCH da rota removida');
  const good = cli(['--base', f['base.yaml'], '--candidate', f['ok.yaml'], '--scope', f['escopo.json'], '--routes-file', f['rotas.json']]);
  assert.equal(good.status, 0, good.stdout);
});

test('m9d840 contrato inválido sai com exit 2', () => {
  const f = tmpFiles({ 'base.yaml': baseContract(), 'ruim.yaml': 'openapi: "3.0.3"\ninfo: { title: x, version: "um" }\npaths: {}\n', 'quebrado.yaml': 'paths: [\n', 'escopo.json': JSON.stringify(SCOPE), 'rotas.json': noRoutes() });
  for (const name of ['ruim.yaml', 'quebrado.yaml']) {
    const run = cli(['--base', f['base.yaml'], '--candidate', f[name], '--scope', f['escopo.json'], '--routes-file', f['rotas.json']]);
    assert.equal(run.status, 2, `${name}: ${run.stdout}`);
    assert.match(run.stdout, /GOV_OPENAPI_INVALID O contrato OpenAPI é inválido: /);
  }
  const noBase = cli(['--base', 'ref-que-nao-existe-xyz', '--candidate', f['base.yaml'], '--scope', f['escopo.json'], '--routes-file', f['rotas.json']]);
  assert.equal(noBase.status, 2);
});

test('m9d840 breaking com major nova passa se v1 segue servida', () => {
  const v1 = baseContract();
  const v2 = clone(baseContract());
  delete v2.paths['/contracts'];
  v2.info.version = '2.0.0';
  const dir = tmpFiles({ 'escopo.json': JSON.stringify(SCOPE), 'rotas.json': noRoutes() });
  const base = path.join(dir.dir, 'base.yaml');
  fs.writeFileSync(base, dump(v1));
  const candidate = path.join(dir.dir, 'openapi.v2.yaml');
  fs.writeFileSync(candidate, dump(v2));
  const run = () => cli(['--base', base, '--candidate', candidate, '--scope', dir['escopo.json'], '--routes-file', dir['rotas.json'], '--json']);
  const missing = run();
  assert.equal(missing.status, 1, 'sem o arquivo da major anterior a v1 deixou de ser servida');
  assert.deepEqual(JSON.parse(missing.stdout).changes.map((c) => c.rule), ['MAJOR_PREVIOUS_MISSING']);
  fs.writeFileSync(path.join(dir.dir, 'openapi.v1.yaml'), dump(v1));
  assert.deepEqual(JSON.parse(run().stdout).changes.map((c) => c.detail), ['falta info.x-deprecated: true', 'falta info.x-sunset com uma data'], 'v1 sem x-deprecated e x-sunset');
  fs.writeFileSync(path.join(dir.dir, 'openapi.v1.yaml'), dump({ ...v1, info: { ...v1.info, 'x-deprecated': true, 'x-sunset': '2027-06-30' } }));
  const ok = run();
  assert.equal(ok.status, 0, ok.stdout);
  assert.equal(JSON.parse(ok.stdout).mode, 'new-major');
});

test('m9d840 rota real sem documentação reprova', () => {
  const routes = [{ method: 'GET', path: '/api/v1/contracts/:id' }, { method: 'POST', path: '/api/v1/contracts' }];
  const report = lint(baseContract(), baseContract(), { routes, scopeJson: SCOPE });
  assert.equal(report.exitCode, 1);
  assert.deepEqual(report.undocumented.map((u) => [u.code, u.method, u.path, u.message]), [['GOV_OPENAPI_ROUTE_UNDOCUMENTED', 'POST', '/contracts', 'Rota sem documentação no contrato: POST /contracts.']]);
});

test('m9d840 rota fora de openapi/escopo.json não reprova', () => {
  const routes = [{ method: 'GET', path: '/api/v1/interna/segredo' }, { method: 'POST', path: '/api/v1/contratos-antigos/:id' }, { method: 'GET', path: '/api/v1/contracts/:id' }];
  const report = lint(baseContract(), baseContract(), { routes, scopeJson: SCOPE });
  assert.deepEqual([report.exitCode, report.undocumented], [0, []]);
  assert.equal(lint(baseContract(), baseContract(), { routes: [{ method: 'DELETE', path: '/api/v1/contracts/:id' }], scopeJson: SCOPE }).exitCode, 1, 'prefixo do escopo cobra qualquer método');
});

test('m9d840 o contrato versionado do repositório cobre todas as rotas reais do escopo fechado', () => {
  const scope = JSON.parse(fs.readFileSync(path.join(ROOT, 'openapi/escopo.json'), 'utf8'));
  assert.ok(scope.entries.includes('/bcp') && scope.entries.includes('/dlp') && scope.entries.includes('/auth/login') && scope.entries.includes('/public'));
  const run = cli(['--base', 'openapi/openapi.v1.yaml', '--candidate', 'openapi/openapi.v1.yaml', '--json']);
  assert.equal(run.status, 0, run.stdout);
  const report = JSON.parse(run.stdout);
  assert.deepEqual([report.undocumented, report.changes], [[], []]);
});

test('m9d840 o contrato lista os 12 tipos de contrato, documenta o 409 da mídia e remover um tipo é breaking', () => {
  const yaml = require('js-yaml');
  const doc = yaml.load(fs.readFileSync(path.join(ROOT, 'openapi/openapi.v1.yaml'), 'utf8'));
  assert.equal(doc.components.schemas.ContractType.enum.length, 12);
  assert.ok(doc.paths['/legal/inspections/items/{itemId}/media'].post.responses[409]);
  const next = clone(doc);
  next.components.schemas.ContractType.enum = next.components.schemas.ContractType.enum.slice(1);
  const report = require('../../../src/features/core-governance/api-governance/openapi/lint.service').lintContracts({ baseText: dump(doc), candidateText: dump(next), candidatePath: path.join(ROOT, 'openapi/openapi.v1.yaml') });
  assert.ok(rulesOf(report).includes('ENUM_VALUE_REMOVED'));
});
