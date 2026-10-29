'use strict';

// M9-D842 — o que o contract test detecta numa resposta real: corpo fora do esquema, status não documentado, código fora do catálogo e erro fora do formato único. Sem banco.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { checkResponse, validate } = require('../../../src/features/core-governance/api-governance/contract');
const { contract, response, operationOf, DATA } = require('../_helpers/m9d842Contract');

const check = (actual, doc = contract(), op = {}) => checkResponse({ ...operationOf(doc), ...op, actual });
const codesOf = (findings) => findings.map((item) => item.code);

test('m9d842 resposta alinhada ao contrato passa sem achados', () => {
  assert.deepEqual(check(response()), []);
  assert.deepEqual(check(response({ status: 404 })), []);
});

test('m9d842 resposta fora do esquema falha o contract test', () => {
  const { dueAt, ...semPrazo } = DATA;
  const missing = check(response({ json: { success: true, data: semPrazo } }));
  assert.deepEqual(codesOf(missing), ['GOV_RESPONSE_SCHEMA_MISMATCH']);
  assert.equal(missing[0].message, 'A resposta de GET /tasks/{id} não segue o contrato.');
  assert.match(missing[0].details.problems.join(' '), /\$\.data\.dueAt: campo obrigatório ausente/);
  assert.match(check(response({ json: { success: true, data: { ...DATA, status: 'ARQUIVADO' } } }))[0].details.problems.join(' '), /fora do enum/, 'enum');
  assert.match(check(response({ json: { success: true, data: { ...DATA, id: 'abc' } } }))[0].details.problems.join(' '), /formato uuid/, 'formato');
  assert.match(check(response({ json: { success: true, data: { ...DATA, dueAt: 20261105 } } }))[0].details.problems.join(' '), /esperava string e veio number/, 'tipo');
  assert.deepEqual(check(response({ json: { success: true, data: { ...DATA, note: null } } })), [], 'nullable aceita null');
  assert.match(check(response({ contentType: 'text/html', json: undefined }))[0].details.problems.join(' '), /tipo de conteúdo text\/html/);
});

test('m9d842 cabeçalho documentado ausente falha o contract test', () => {
  const findings = check(response({ headers: {} }));
  assert.deepEqual(codesOf(findings), ['GOV_RESPONSE_SCHEMA_MISMATCH']);
  assert.match(findings[0].details.problems.join(' '), /X-Correlation-Id documentado e ausente/);
});

test('m9d842 status não documentado falha', () => {
  const findings = check(response({ status: 500, json: { success: false, error: { code: 'INTERNAL_ERROR', message: 'x', traceId: 'corr-1' } } }));
  assert.deepEqual(codesOf(findings), ['GOV_STATUS_NOT_DOCUMENTED']);
  assert.equal(findings[0].message, 'Status 500 não está no contrato de /tasks/{id}.');
});

test('m9d842 erro com código fora do catálogo reprova', () => {
  const findings = check(response({ status: 404, json: { success: false, error: { code: 'GOV_NAO_EXISTE', message: 'x', traceId: 'corr-1' } } }));
  assert.ok(codesOf(findings).includes('GOV_ERROR_CODE_UNKNOWN'));
  assert.equal(findings.find((item) => item.code === 'GOV_ERROR_CODE_UNKNOWN').message, 'Código de erro não catalogado: GOV_NAO_EXISTE.');
  assert.ok(codesOf(findings).includes('GOV_RESPONSE_SCHEMA_MISMATCH'), 'também difere do x-error-code documentado');
});

test('m9d842 erro com traceId na raiz ou sem error.traceId reprova', () => {
  const rootTrace = check(response({ status: 404, json: { success: false, traceId: 'corr-1', error: { code: 'GOV_NOT_FOUND', message: 'x' } } }));
  assert.deepEqual(codesOf(rootTrace), ['GOV_RESPONSE_SCHEMA_MISMATCH']);
  assert.match(rootTrace[0].details.problems.join(' | '), /traceId na raiz/);
  assert.match(rootTrace[0].details.problems.join(' | '), /error\.traceId ausente/);
  const noTrace = check(response({ status: 404, json: { success: false, error: { code: 'GOV_NOT_FOUND', message: 'x' } } }));
  assert.match(noTrace[0].details.problems.join(' | '), /error\.traceId ausente/);
  const other = check(response({ status: 404, json: { success: false, error: { code: 'GOV_NOT_FOUND', message: 'x', traceId: 'outro' } } }));
  assert.match(other[0].details.problems.join(' | '), /difere de X-Correlation-Id/);
  const flat = check(response({ status: 404, json: { success: false, code: 'GOV_NOT_FOUND', message: 'x' } }));
  assert.ok(codesOf(flat).includes('GOV_RESPONSE_SCHEMA_MISMATCH'));
});

test('m9d842 validador de esquema cobre composição, itens e limites', () => {
  const components = { schemas: { Id: { type: 'string', minLength: 3 } } };
  assert.deepEqual(validate({ type: 'array', items: { $ref: '#/components/schemas/Id' } }, ['abc', 'abcd'], components), []);
  assert.equal(validate({ type: 'array', items: { $ref: '#/components/schemas/Id' } }, ['abc', 'a'], components)[0].path, '$[1]');
  assert.equal(validate({ oneOf: [{ type: 'string' }, { type: 'integer' }] }, true, components).length, 1);
  assert.equal(validate({ type: 'object', additionalProperties: false, properties: { a: { type: 'integer', minimum: 1 } } }, { a: 0, b: 1 }, components).length, 2);
  assert.equal(validate({ $ref: '#/components/schemas/Nada' }, 1, components)[0].message, 'referência #/components/schemas/Nada não resolvida');
});
