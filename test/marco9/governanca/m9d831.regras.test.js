'use strict';

// M9-D831 — regras de registro e edição: payload inválido fica RECORDED com validation_errors, PATCH, form_type x ação, setor do usuário e filtros da listagem.
const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const env = require('../_helpers/bcpEnv');
const service = require('../../../src/features/core-governance/bcp/manualOperation.service');

let A;
let makerId;
const skip = () => (env.DISPOSABLE ? false : env.SKIP_DISPOSABLE);
const { failure } = env;
const patch = (id, payload, actor) => env.inTx(A, (tx) => service.updatePayload({ tenant: env.tenantOf(A), actorUserId: actor, id, body: { payload }, transaction: tx }), actor);
const list = (actor, query = {}) => env.inTx(A, (tx) => service.listOperations({ tenant: env.tenantOf(A), actorUserId: actor, query, transaction: tx }), actor);

before(async () => {
  if (!env.DISPOSABLE) return;
  ({ A } = await env.loadTenants());
  makerId = await env.otherUserId();
  await env.cleanBcp();
  await env.setSectorRoles(A, { FINANCEIRO: ['CI GESTOR'], OBRAS: ['CI GESTOR', 'CI MAKER'] });
});
afterEach(async () => { if (env.DISPOSABLE) await env.adminQuery('DELETE FROM governance.manual_operations'); });
after(async () => { if (env.DISPOSABLE) { await env.cleanBcp(); await env.sequelize.close(); } });

test('m9d831 payload inválido é gravado RECORDED com validation_errors', { skip: skip() }, async () => {
  const bad = { ...env.RECEBIMENTO, valorCentavos: '1250.00', forma: 'BOLETO' };
  delete bad.pagador;
  const op = await env.record(A, { payload: bad });
  assert.equal(op.status, 'RECORDED');
  const fields = op.validationErrors.map((e) => e.field).sort();
  assert.deepEqual(fields, ['forma', 'pagador', 'valorCentavos']);
  const row = await env.opRow(op.id);
  assert.equal(row.validation_errors.length, 3);
  assert.deepEqual(row.payload, bad, 'o papel é guardado como veio');
  const noPayload = await env.record(A, { payload: undefined });
  assert.ok(noPayload.validationErrors.length >= 6, 'sem payload também grava, com todos os obrigatórios faltando');
  const notObject = await env.record(A, { payload: 'texto' });
  assert.equal(notObject.status, 'RECORDED');
  assert.equal(notObject.validationErrors[0].field, 'payload');
});

test('m9d831 PATCH corrige o payload, limpa o erro e guarda a versão anterior na auditoria', { skip: skip() }, async () => {
  const op = await env.record(A, { payload: { ...env.RECEBIMENTO, valorCentavos: 12.5 } });
  assert.equal(op.validationErrors.length, 1);
  const still = await failure(patch(op.id, { ...env.RECEBIMENTO, valorCentavos: '1250.00' }, A.userId));
  assert.deepEqual([still.status, still.code, still.message], [422, 'GOV_BCP_PAYLOAD_INVALID', 'Os dados do formulário não passam nas regras do sistema.']);
  assert.equal(still.details.errors[0].field, 'valorCentavos');
  assert.equal((await env.opRow(op.id)).validation_errors.length, 1, 'continua com o erro anterior');
  const fixed = await patch(op.id, env.RECEBIMENTO, A.userId);
  assert.deepEqual([fixed.validationErrors, fixed.payload.valorCentavos, fixed.status], [[], 125000, 'RECORDED']);
  const audit = (await env.auditOf(A, 'bcp.manual_operation.updated')).find((a) => a.entity_id === op.id);
  assert.equal(audit.before_json.payload.valorCentavos, 12.5, 'antes na auditoria');
  assert.equal(audit.after_json.payload.valorCentavos, 125000, 'depois na auditoria');
});

test('m9d831 PATCH em operação IMPORTED devolve 409 GOV_BCP_NOT_EDITABLE', { skip: skip() }, async () => {
  for (const status of ['IMPORTED', 'REJECTED', 'RECONCILED']) {
    const op = await env.record(A);
    await env.adminQuery('UPDATE governance.manual_operations SET status = $1 WHERE id = $2', [status, op.id]);
    const err = await failure(patch(op.id, env.RECEBIMENTO, A.userId));
    assert.deepEqual([err.status, err.code, err.message], [409, 'GOV_BCP_NOT_EDITABLE', 'Esta operação já foi importada e não pode ser editada.'], status);
  }
  const missing = await failure(patch('00000000-0000-4000-8000-000000000000', env.RECEBIMENTO, A.userId));
  assert.equal(missing.status, 404);
});

test('m9d831 form_type incompatível com o setor ou com a ação devolve 422 GOV_BCP_ACTION_INVALID', { skip: skip() }, async () => {
  const cases = [
    { formType: 'DIARIO_OBRA' },
    { intendedAction: 'DAILY_REPORT' },
    { formType: 'NAO_EXISTE' },
    { intendedAction: 'EMERGENCY_PAYMENT' },
    { formType: undefined },
  ];
  for (const over of cases) {
    const err = await failure(env.record(A, over));
    assert.deepEqual([err.status, err.code, err.message], [422, 'GOV_BCP_ACTION_INVALID', 'Esta ação não existe para o setor.'], JSON.stringify(over));
  }
});

test('m9d831 usuário de outro setor não registra e nem edita', { skip: skip() }, async () => {
  const mine = await env.record(A);
  const denied = await failure(env.record(A, {}, makerId));
  assert.deepEqual([denied.status, denied.code, denied.message], [403, 'GOV_BCP_SECTOR_FORBIDDEN', 'Você não pode registrar operações deste setor.']);
  const patchDenied = await failure(patch(mine.id, env.RECEBIMENTO, makerId));
  assert.equal(patchDenied.code, 'GOV_BCP_SECTOR_FORBIDDEN');
  const obras = await env.record(A, { sector: 'OBRAS', manualReference: env.reference('OBR'), formType: 'DIARIO_OBRA', intendedAction: 'DAILY_REPORT', payload: env.DIARIO }, makerId);
  assert.equal(obras.actorUserId, makerId, 'no setor dele registra');
  const invalidSector = await failure(env.record(A, { sector: 'RH' }));
  assert.equal(invalidSector.code, 'VALIDATION_ERROR');
  await env.setSectorRoles(A, { FINANCEIRO: ['NINGUEM'] });
  const none = await failure(env.record(A));
  assert.equal(none.code, 'GOV_BCP_SECTOR_FORBIDDEN', 'sem setor, nenhuma operação');
  await env.setSectorRoles(A, { FINANCEIRO: ['CI GESTOR'], OBRAS: ['CI GESTOR', 'CI MAKER'] });
});

test('m9d831 duas operações do mesmo correlation_ref são listadas juntas, limitadas aos setores do usuário', { skip: skip() }, async () => {
  const correlationRef = '5f1b7a60-3c2d-4b1e-9a77-0d8e6c2f1a11';
  const a = await env.record(A, { correlationRef });
  const b = await env.record(A, { correlationRef, sector: 'OBRAS', manualReference: env.reference('OBR'), formType: 'DIARIO_OBRA', intendedAction: 'DAILY_REPORT', payload: env.DIARIO });
  await env.record(A);
  const together = (await list(A.userId, { correlationRef })).items;
  assert.deepEqual(together.map((o) => o.id).sort(), [a.id, b.id].sort());
  assert.deepEqual((await list(A.userId, { sector: 'OBRAS' })).items.map((o) => o.id), [b.id]);
  assert.equal((await list(A.userId, { status: 'IMPORTED' })).items.length, 0);
  assert.deepEqual((await list(makerId, {})).items.map((o) => o.id), [b.id], 'o usuário de OBRAS só enxerga o setor dele');
  assert.deepEqual((await list(makerId, { sector: 'FINANCEIRO' })).items, []);
  assert.equal((await failure(list(A.userId, { correlationRef: 'x' }))).code, 'VALIDATION_ERROR');
  assert.equal((await failure(list(A.userId, { status: 'X' }))).code, 'VALIDATION_ERROR');
  await env.inTx(A, (tx) => require('../../../src/features/settings/settings.service').upsertSetting('governanca.bcp.listagem_limite', 1, env.tenantOf(A), A.userId, tx));
  const first = await list(A.userId, {});
  assert.equal(first.items.length, 1, 'o parâmetro governanca.bcp.listagem_limite é o tamanho padrão da página');
  assert.equal(first.pagination.pageSize, 1);
  assert.ok(first.pagination.total >= 3 && first.pagination.totalPages === first.pagination.total, 'o bloco pagination traz o total real');
  assert.equal((await list(A.userId, { page: 2, pageSize: 1 })).items.length, 1);
  assert.equal((await list(A.userId, { pageSize: 200 })).pagination.pageSize, 200, 'pageSize pedido vale mesmo acima do padrão do parâmetro');
});
