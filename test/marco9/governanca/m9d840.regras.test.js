'use strict';

// M9-D840 — as 9 regras de breaking change (lista fechada do livro), uma a uma, mais as exceções. Sem banco: compara dois contratos.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { baseContract, clone, lint, rulesOf, json } = require('../_helpers/m9d840Contracts');

const GET = '/contracts/{id}';
const res200 = (doc) => doc.paths[GET].get.responses[200].content['application/json'].schema;
const body = (doc) => doc.paths[GET].patch.requestBody.content['application/json'].schema;

test('m9d840 mudança de tipo detectada', () => {
  const next = clone(baseContract());
  res200(next).properties.dueAt = { type: 'string' };
  const report = lint(baseContract(), next);
  assert.equal(report.exitCode, 1);
  assert.deepEqual(rulesOf(report), ['TYPE_CHANGED']);
  assert.equal(report.changes[0].code, 'GOV_OPENAPI_BREAKING_CHANGE');
  assert.match(report.changes[0].message, /^Mudança incompatível dentro da major 1: TYPE_CHANGED em GET \/contracts\/\{id\} 200\.dueAt\.$/);
  const typeSwap = clone(baseContract());
  res200(typeSwap).properties.dueAt = { type: 'number' };
  assert.deepEqual(rulesOf(lint(baseContract(), typeSwap)), ['TYPE_CHANGED'], 'string -> number');
  const format = clone(baseContract());
  res200(format).properties.dueAt = { type: 'string', format: 'date-time' };
  assert.deepEqual(rulesOf(lint(baseContract(), format)), ['TYPE_CHANGED'], 'date -> date-time');
});

test('m9d840 campo opcional novo não é breaking', () => {
  const next = clone(baseContract());
  res200(next).properties.note = { type: 'string' };
  next.paths[GET].get.parameters.push({ name: 'filter', in: 'query', required: false, schema: { type: 'string' } });
  next.paths['/contracts/{id}/audit'] = { get: { operationId: 'audit', responses: { 200: { description: 'ok' } } } };
  body(next).properties.extra = { type: 'string' };
  body(next).properties.title.maxLength = 200;
  next.paths[GET].get.responses[500] = { description: 'erro' };
  const report = lint(baseContract(), next);
  assert.deepEqual([report.exitCode, report.changes], [0, []]);
});

test('m9d840 regra 1 remover rota, método, parâmetro ou resposta é breaking', () => {
  const noRoute = clone(baseContract());
  delete noRoute.paths['/contracts'];
  const routeReport = lint(baseContract(), noRoute);
  assert.deepEqual([routeReport.exitCode, rulesOf(routeReport)], [1, ['ROUTE_REMOVED']]);
  const noMethod = clone(baseContract());
  delete noMethod.paths[GET].patch;
  assert.deepEqual(rulesOf(lint(baseContract(), noMethod)), ['METHOD_REMOVED']);
  const noParam = clone(baseContract());
  noParam.paths[GET].get.parameters = noParam.paths[GET].get.parameters.filter((p) => p.name !== 'expand');
  assert.deepEqual(rulesOf(lint(baseContract(), noParam)), ['PARAM_REMOVED']);
  const noResponse = clone(baseContract());
  delete noResponse.paths[GET].get.responses[404];
  assert.deepEqual(rulesOf(lint(baseContract(), noResponse)), ['RESPONSE_REMOVED']);
});

test('m9d840 regra 2 renomear rota ou campo é breaking', () => {
  const renamedRoute = clone(baseContract());
  renamedRoute.paths['/agreements'] = renamedRoute.paths['/contracts'];
  delete renamedRoute.paths['/contracts'];
  assert.deepEqual(rulesOf(lint(baseContract(), renamedRoute)), ['ROUTE_RENAMED']);
  const renamedField = clone(baseContract());
  const props = res200(renamedField).properties;
  props.deadline = props.dueAt;
  delete props.dueAt;
  res200(renamedField).required = ['id', 'deadline', 'status'];
  assert.ok(rulesOf(lint(baseContract(), renamedField)).includes('FIELD_RENAMED'));
  const renamedOptionalRequestField = clone(baseContract());
  body(renamedOptionalRequestField).properties.remark = body(renamedOptionalRequestField).properties.note;
  delete body(renamedOptionalRequestField).properties.note;
  assert.deepEqual(rulesOf(lint(baseContract(), renamedOptionalRequestField)), ['FIELD_RENAMED'], 'também na requisição');
});

test('m9d840 regra 3 parâmetro ou campo de requisição obrigatório novo é breaking', () => {
  const newRequiredParam = clone(baseContract());
  newRequiredParam.paths[GET].get.parameters.push({ name: 'tenant', in: 'query', required: true, schema: { type: 'string' } });
  assert.deepEqual(rulesOf(lint(baseContract(), newRequiredParam)), ['REQUEST_REQUIRED_ADDED']);
  const nowRequiredParam = clone(baseContract());
  nowRequiredParam.paths[GET].get.parameters.find((p) => p.name === 'expand').required = true;
  assert.deepEqual(rulesOf(lint(baseContract(), nowRequiredParam)), ['REQUEST_REQUIRED_ADDED']);
  const nowRequiredField = clone(baseContract());
  body(nowRequiredField).required = ['title', 'note'];
  assert.deepEqual(rulesOf(lint(baseContract(), nowRequiredField)), ['REQUEST_REQUIRED_ADDED']);
  const newRequiredField = clone(baseContract());
  body(newRequiredField).properties.reason = { type: 'string' };
  body(newRequiredField).required = ['title', 'reason'];
  assert.deepEqual(rulesOf(lint(baseContract(), newRequiredField)), ['REQUEST_REQUIRED_ADDED']);
  const bodyRequired = clone(baseContract());
  bodyRequired.paths[GET].patch.requestBody.required = true;
  assert.deepEqual(rulesOf(lint(baseContract(), bodyRequired)), ['REQUEST_REQUIRED_ADDED']);
});

test('m9d840 regra 4 campo de resposta removido ou anulável é breaking', () => {
  const removed = clone(baseContract());
  delete res200(removed).properties.owner;
  assert.deepEqual(rulesOf(lint(baseContract(), removed)), ['FIELD_REMOVED']);
  const optional = clone(baseContract());
  res200(optional).required = ['id', 'status'];
  assert.deepEqual(rulesOf(lint(baseContract(), optional)), ['FIELD_NOT_REQUIRED']);
  const nullable = clone(baseContract());
  res200(nullable).properties.id.nullable = true;
  assert.deepEqual(rulesOf(lint(baseContract(), nullable)), ['FIELD_NULLABLE']);
});

test('m9d840 regra 6 remover valor de enum de resposta e adicionar em enum x-closed são breaking', () => {
  const removed = clone(baseContract());
  res200(removed).properties.status.enum = ['OPEN'];
  assert.deepEqual(rulesOf(lint(baseContract(), removed)), ['ENUM_VALUE_REMOVED']);
  const added = clone(baseContract());
  res200(added).properties.status.enum = ['OPEN', 'CLOSED', 'ARCHIVED'];
  assert.equal(lint(baseContract(), added).exitCode, 0, 'enum de resposta aberto aceita valor novo');
  const closedBase = clone(baseContract());
  res200(closedBase).properties.status['x-closed'] = true;
  const closedNext = clone(closedBase);
  res200(closedNext).properties.status.enum = ['OPEN', 'CLOSED', 'ARCHIVED'];
  assert.deepEqual(rulesOf(lint(closedBase, closedNext)), ['ENUM_VALUE_ADDED_CLOSED']);
  const requestAdded = clone(baseContract());
  body(requestAdded).properties.kind.enum = ['A', 'B', 'C'];
  assert.equal(lint(baseContract(), requestAdded).exitCode, 0, 'valor novo em enum de requisição nunca é breaking');
  const requestRemoved = clone(baseContract());
  body(requestRemoved).properties.kind.enum = ['A'];
  assert.deepEqual(rulesOf(lint(baseContract(), requestRemoved)), ['ENUM_VALUE_REMOVED'], 'remover valor aceito na requisição quebra quem o envia (AUD-015)');
});

test('m9d840 regra 7 apertar restrição de requisição é breaking', () => {
  const shorter = clone(baseContract());
  body(shorter).properties.title.maxLength = 50;
  assert.deepEqual(rulesOf(lint(baseContract(), shorter)), ['CONSTRAINT_TIGHTENED']);
  const minimum = clone(baseContract());
  body(minimum).properties.note = { type: 'integer', minimum: 5 };
  const withMinimum = clone(baseContract());
  body(withMinimum).properties.note = { type: 'integer', minimum: 1 };
  assert.deepEqual(rulesOf(lint(withMinimum, minimum)), ['CONSTRAINT_TIGHTENED']);
  const pattern = clone(baseContract());
  body(pattern).properties.title.pattern = '^[A-Z]+$';
  assert.deepEqual(rulesOf(lint(baseContract(), pattern)), ['CONSTRAINT_TIGHTENED']);
  const looser = clone(baseContract());
  body(looser).properties.title.maxLength = 300;
  assert.equal(lint(baseContract(), looser).exitCode, 0, 'afrouxar não é breaking');
});

test('m9d840 regra 8 mudar esquema de segurança ou escopo é breaking', () => {
  const scheme = clone(baseContract());
  scheme.components.securitySchemes.apiKey = { type: 'apiKey', in: 'header', name: 'X-Key' };
  scheme.paths[GET].get.security = [{ apiKey: [] }];
  assert.deepEqual(rulesOf(lint(baseContract(), scheme)), ['SECURITY_CHANGED']);
  const scope = clone(baseContract());
  scope.components.securitySchemes.oauth = { type: 'oauth2', flows: { clientCredentials: { tokenUrl: '/t', scopes: { read: 'r', write: 'w' } } } };
  const withScope = clone(scope);
  withScope.paths[GET].get.security = [{ oauth: ['read'] }];
  const widerScope = clone(scope);
  widerScope.paths[GET].get.security = [{ oauth: ['read', 'write'] }];
  assert.deepEqual(rulesOf(lint(withScope, widerScope)), ['SECURITY_CHANGED']);
});

test('m9d840 regra 9 mudar código de erro estável é breaking', () => {
  const changed = clone(baseContract());
  changed.paths[GET].get.responses[404]['x-error-code'] = 'GOV_CONTRACT_MISSING';
  const catalog = '| Código | Status | Mensagem |\n|---|---|---|\n| `GOV_NOT_FOUND` | 404 | Registro não encontrado. |\n| `GOV_CONTRACT_MISSING` | 404 | Contrato não encontrado. |\n';
  const report = lint(baseContract(), changed, { errorCatalogText: catalog });
  assert.deepEqual([report.exitCode, rulesOf(report)], [1, ['ERROR_CODE_CHANGED']]);
  const unknown = clone(baseContract());
  unknown.paths[GET].get.responses[404]['x-error-code'] = 'GOV_INVENTADO';
  const notInCatalog = lint(null, unknown, { errorCatalogText: catalog });
  assert.deepEqual(rulesOf(notInCatalog), ['ERROR_CODE_CHANGED'], 'código fora do catálogo gerado pela D843');
  assert.equal(lint(baseContract(), baseContract(), { errorCatalogText: catalog }).exitCode, 0);
});

test('m9d840 breaking API change detectado', () => {
  const next = clone(baseContract());
  delete next.paths[GET];
  next.info.version = '1.5.0';
  const report = lint(baseContract(), next);
  assert.equal(report.exitCode, 1);
  assert.ok(report.changes.some((c) => c.code === 'GOV_OPENAPI_BREAKING_CHANGE' && c.rule === 'ROUTE_REMOVED'));
  assert.ok(report.text.includes('GOV_OPENAPI_BREAKING_CHANGE'));
  assert.equal(json({}).content['application/json'].schema !== undefined, true);
});
