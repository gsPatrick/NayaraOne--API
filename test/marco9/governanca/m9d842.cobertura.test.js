'use strict';

// M9-D842 — cobertura do contract test: exemplo positivo e negativo por operação, rota real do escopo ausente do contrato e escopo fechado. Sem banco.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { coverageFindings } = require('../../../src/features/core-governance/api-governance/contract');
const { contract } = require('../_helpers/m9d842Contract');

const SCOPE = JSON.stringify({ entries: ['/tasks'] });
const pos = (op, extra = {}) => ({ op, kind: 'positive', name: 'p', as: 'gestor', expect: 200, ...extra });
const neg = (op, extra = {}) => ({ op, kind: 'negative', name: 'n', as: 'anon', expect: 404, ...extra });
const find = (examples, extra = {}) => coverageFindings({ doc: contract(), examples, routes: [], scopeJson: SCOPE, ...extra });
const pairs = (findings) => findings.map((item) => [item.code, item.details.op, item.details.missing || item.details.reason]);

test('m9d842 operação sem exemplo negativo reprova', () => {
  const findings = find([pos('GET /tasks/{id}'), pos('GET /ping')]);
  const missing = findings.filter((item) => item.code === 'GOV_CONTRACT_EXAMPLE_MISSING');
  assert.deepEqual(pairs(missing), [['GOV_CONTRACT_EXAMPLE_MISSING', 'GET /tasks/{id}', 'negative'], ['GOV_CONTRACT_EXAMPLE_MISSING', 'GET /ping', 'NO_4XX_DOCUMENTED']]);
  assert.equal(missing[0].message, 'Falta exemplo positivo ou negativo para GET /tasks/{id}.');
});

test('m9d842 operação sem exemplo positivo ou sem nenhum exemplo reprova', () => {
  const noPositive = pairs(find([neg('GET /tasks/{id}')]).filter((item) => item.details.op === 'GET /tasks/{id}'));
  assert.deepEqual(noPositive, [['GOV_CONTRACT_EXAMPLE_MISSING', 'GET /tasks/{id}', 'positive']]);
  const none = find([]).filter((item) => item.details.op === 'GET /tasks/{id}');
  assert.deepEqual(none.map((item) => item.details.missing), ['positive', 'negative']);
});

test('m9d842 contrato com todos os exemplos passa (100 de 100)', () => {
  const doc = contract();
  doc.paths['/ping'].get.responses[400] = { description: 'x' };
  assert.deepEqual(coverageFindings({ doc, examples: [pos('GET /tasks/{id}'), neg('GET /tasks/{id}'), pos('GET /ping'), neg('GET /ping', { expect: 400 })], routes: [], scopeJson: SCOPE }), []);
});

test('m9d842 exemplo de operação inexistente ou negativo com status não documentado reprova', () => {
  const findings = find([pos('GET /tasks/{id}'), neg('GET /tasks/{id}'), pos('GET /sumiu'), neg('GET /tasks/{id}', { expect: 409, name: 'conflito' })]);
  const invalid = findings.filter((item) => item.code === 'GOV_CONTRACT_EXAMPLE_INVALID');
  assert.equal(invalid.length, 2);
  assert.match(invalid[0].message, /GET \/sumiu/);
  assert.match(invalid[1].message, /409 do exemplo negativo "conflito"/);
});

test('m9d842 rota ausente do contrato reprova', () => {
  const routes = [{ method: 'GET', path: '/api/v1/tasks/:id' }, { method: 'POST', path: '/api/v1/tasks' }, { method: 'DELETE', path: '/api/v1/tasks/:id/anexos/:anexoId' }];
  const findings = find([], { routes }).filter((item) => item.code === 'GOV_OPENAPI_ROUTE_UNDOCUMENTED');
  assert.deepEqual(findings.map((item) => `${item.details.method} ${item.details.path}`), ['POST /tasks', 'DELETE /tasks/{id}/anexos/{anexoId}']);
  assert.equal(findings[0].message, 'Rota sem documentação no contrato: POST /tasks.');
});

test('m9d842 rota fora do escopo fechado não é exigida no contrato', () => {
  const routes = [{ method: 'GET', path: '/api/v1/interna/segredo' }, { method: 'POST', path: '/api/v1/outro/{id}' }, { method: 'GET', path: '/api/v1/tasks/:id' }];
  assert.deepEqual(find([], { routes }).filter((item) => item.code === 'GOV_OPENAPI_ROUTE_UNDOCUMENTED'), []);
  const exact = JSON.stringify({ entries: ['POST /outro/{id}'] });
  assert.deepEqual(find([], { routes, scopeJson: exact }).filter((item) => item.code === 'GOV_OPENAPI_ROUTE_UNDOCUMENTED').map((item) => item.details.path), ['/outro/{id}'], 'a rota exata entra no escopo');
});
