'use strict';

// M9-D834 — rotas reais: leitura dos modelos só para quem é do setor, impressão em PDF, faixa inválida e a validação do payload pelo esquema do modelo.
process.env.PORT = process.env.M9D834_HTTP_TEST_PORT || '21834';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startHttp, stopHttp } = require('../_helpers/m9d806Http');
const env = require('../_helpers/bcpEnv');
const { getRaw, pageCount } = require('../_helpers/bcpPrintHttp');
const { pdfText } = require('../_helpers/exportsEnv');
const { SPEC } = require('../_helpers/m9d834Spec');

let http;
let A;
let restore;
const skip = () => (http && http.skip) || (env.DISPOSABLE ? false : env.SKIP_DISPOSABLE);
const RECORD = 'governance:bcp:record';
const IMPORT = 'governance:bcp:import';

before(async () => {
  if (!env.DISPOSABLE) return;
  restore = await env.withRolePermissions({ 'CI GESTOR': { [RECORD]: true, [IMPORT]: true }, 'CI MAKER': { [RECORD]: false, [IMPORT]: true }, 'CI LEITURA': { [RECORD]: false, [IMPORT]: false } });
  http = await startHttp({ port: process.env.PORT, grants: {}, logins: { gestorA: ['A', 'gestor'], makerA: ['A', 'maker'], leituraA: ['A', 'leitura'] } });
  A = http.tenants.A;
  await env.cleanBcp();
  await env.setSectorRoles(A, { FINANCEIRO: ['CI GESTOR', 'CI MAKER'], OBRAS: ['CI GESTOR'] });
});
after(async () => {
  if (env.DISPOSABLE) { await env.cleanBcp(); await restore(); }
  await stopHttp({});
});

test('m9d834 HTTP: a lista de modelos traz só os setores do usuário, com campos e esquema', { skip: skip() }, async () => {
  const all = await http.call('gestorA', 'GET', '/bcp/form-templates');
  assert.equal(all.status, 200, JSON.stringify(all.body));
  assert.deepEqual(all.body.data.map((t) => t.sector).filter((s, i, a) => a.indexOf(s) === i).sort(), ['FINANCEIRO', 'OBRAS']);
  assert.equal(all.body.data.length, 4, '2 do financeiro e 2 de obras');
  const one = all.body.data.find((t) => t.formType === 'RECEBIMENTO');
  assert.equal(one.intendedAction, 'RECEIVE_PAYMENT');
  assert.ok(one.fields.length === 7 && one.payloadSchema.required.includes('valorCentavos'));
  const maker = await http.call('makerA', 'GET', '/bcp/form-templates');
  assert.deepEqual(maker.body.data.map((t) => t.sector), ['FINANCEIRO', 'FINANCEIRO'], 'só o setor do maker');
  assert.equal((await http.call('makerA', 'GET', '/bcp/form-templates?sector=OBRAS')).body.data.length, 0, 'setor alheio filtrado fica vazio');
  const denied = await http.call('leituraA', 'GET', '/bcp/form-templates');
  assert.deepEqual([denied.status, denied.body.error.code], [403, 'PERMISSION_DENIED']);
});

test('m9d834 HTTP: impressão em PDF dos 11 formulários, em branco, para quem é do setor (ADMIN tem os seis)', { skip: skip() }, async () => {
  const fin = SPEC.filter((s) => s.sector === 'FINANCEIRO');
  for (const spec of fin) {
    const res = await getRaw(http, 'makerA', `/bcp/form-templates/${spec.sector}/${spec.formType}/print`);
    assert.equal(res.status, 200, spec.formType);
    assert.match(res.headers.get('content-type'), /application\/pdf/);
    assert.match(res.headers.get('content-disposition'), /\.pdf/);
    assert.equal(pageCount(res.buffer), 1);
  }
  const folhas = await getRaw(http, 'gestorA', '/bcp/form-templates/FINANCEIRO/RECEBIMENTO/print?from=41&to=140&year=2026');
  assert.equal(folhas.status, 200);
  assert.equal(pageCount(folhas.buffer), 100);
  const text = pdfText(folhas.buffer);
  assert.ok(text.includes('FIN-2026-00041') && text.includes('FIN-2026-00140'));
});

test('m9d834 HTTP: setor alheio 403, formulário inexistente 404, faixa inválida 400', { skip: skip() }, async () => {
  const other = await getRaw(http, 'makerA', '/bcp/form-templates/OBRAS/DIARIO_OBRA/print');
  assert.deepEqual([other.status, other.json.error.code], [403, 'GOV_BCP_SECTOR_FORBIDDEN']);
  const missing = await getRaw(http, 'gestorA', '/bcp/form-templates/FINANCEIRO/DIARIO_OBRA/print');
  assert.deepEqual([missing.status, missing.json.error.code], [404, 'GOV_BCP_FORM_NOT_FOUND']);
  const range = await getRaw(http, 'gestorA', '/bcp/form-templates/FINANCEIRO/RECEBIMENTO/print?from=9&to=3');
  assert.deepEqual([range.status, range.json.error.code], [400, 'GOV_BCP_RANGE_INVALID']);
  const noPerm = await getRaw(http, 'leituraA', '/bcp/form-templates/FINANCEIRO/RECEBIMENTO/print');
  assert.equal(noPerm.status, 403);
});

test('m9d834 HTTP: form_type incompatível com o setor ou com a ação devolve 422 GOV_BCP_ACTION_INVALID', { skip: skip() }, async () => {
  const post = async (over) => http.call('gestorA', 'POST', '/bcp/manual-operations', env.body(A, { evidenceFileId: await env.evidence(A), ...over }));
  for (const over of [{ formType: 'DIARIO_OBRA' }, { intendedAction: 'DAILY_REPORT' }, { formType: 'NAO_EXISTE' }]) {
    const res = await post(over);
    assert.deepEqual([res.status, res.body.error.code], [422, 'GOV_BCP_ACTION_INVALID'], JSON.stringify(over));
  }
});

test('m9d834 HTTP: valor decimal fica RECORDED com validation_errors no registro e é 422 no PATCH', { skip: skip() }, async () => {
  const evidenceFileId = await env.evidence(A);
  const made = await http.call('gestorA', 'POST', '/bcp/manual-operations', env.body(A, { evidenceFileId, payload: { ...env.RECEBIMENTO, valorCentavos: '1250.00' } }));
  assert.equal(made.status, 201);
  assert.equal(made.body.data.status, 'RECORDED');
  assert.deepEqual(made.body.data.validationErrors.map((e) => e.field), ['valorCentavos']);
  const patch = await http.call('gestorA', 'PATCH', `/bcp/manual-operations/${made.body.data.id}`, { payload: { ...env.RECEBIMENTO, valorCentavos: '1250.00' } });
  assert.deepEqual([patch.status, patch.body.error.code], [422, 'GOV_BCP_PAYLOAD_INVALID']);
  const fixed = await http.call('gestorA', 'PATCH', `/bcp/manual-operations/${made.body.data.id}`, { payload: { ...env.RECEBIMENTO, valorCentavos: 125000 } });
  assert.equal(fixed.status, 200);
});
