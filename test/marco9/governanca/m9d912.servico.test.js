'use strict';

// M9-D912 — retenção legal (legal hold): criação, escopo, erros do livro, auditoria, liberação, isolamento entre empresas e o modelo no banco.
// Banco descartável (scripts/withDisposableDb.js); sem ele os testes aparecem como pulados.
const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const env = require('../_helpers/m9d912Env');

let tenants;
const A = () => tenants.A;
const B = () => tenants.B;
const code = (label) => env.code(label);
const NONE = '00000000-0000-4000-8000-0000000000bb';
before(async () => { if (env.DISPOSABLE) { tenants = await env.loadTenants(); await env.resetHolds(A()); await env.resetHolds(B()); env.useRealGuard(); } });
afterEach(async () => { if (env.DISPOSABLE) { await env.resetHolds(A()); await env.resetHolds(B()); } });
after(async () => { await env.sequelize.close(); });
const rejects = (promise, status, errCode) => assert.rejects(promise, (err) => { assert.deepEqual([err.statusCode || err.status, err.code], [status, errCode], `${err.code}: ${err.message}`); return true; });

test('m9d912 hold com código repetido devolve 409 e liberação sem motivo devolve 422', { skip: env.skip() }, async () => {
  const person = await env.insertPerson(A());
  const c = code('DUP');
  const first = await env.createHold(A(), { code: c, scope: [{ type: 'PERSON', id: person }] });
  assert.equal(first.status, 'ACTIVE');
  await rejects(env.createHold(A(), { code: c, scope: [{ type: 'PERSON', id: person }] }), 409, 'GOV_HOLD_CODE_DUPLICATE');
  await assert.rejects(env.createHold(A(), { code: c, scope: [{ type: 'PERSON', id: person }] }), /Já existe uma retenção com este código\./);
  for (const reason of [undefined, '', '   ']) {
    await rejects(env.withTx(A(), (tx) => env.holds.release(A(), { userId: A().userId }, first.id, { release_reason: reason }, tx)), 422, 'GOV_HOLD_RELEASE_REASON_REQUIRED');
  }
  assert.equal((await env.withTx(A(), (tx) => env.holds.get(A(), first.id, tx))).status, 'ACTIVE', 'a recusa não liberou nada');
  const released = await env.releaseHold(A(), first.id, 'Processo arquivado');
  assert.deepEqual([released.status, released.releaseReason], ['RELEASED', 'Processo arquivado']);
  await rejects(env.releaseHold(A(), first.id), 409, 'GOV_HOLD_ALREADY_RELEASED');
});

test('m9d912 criar sem motivo ou sem referência é 422, escopo vazio é 422 e escopo inválido é 422 com a mensagem do livro', { skip: env.skip() }, async () => {
  const person = await env.insertPerson(A());
  const scope = [{ type: 'PERSON', id: person }];
  for (const bad of [{ reason: '' }, { reason: '   ' }, { matter_ref: '' }, { matter_ref: undefined }]) {
    await assert.rejects(env.createHold(A(), { ...bad, scope }), (err) => { assert.deepEqual([err.statusCode || err.status, err.code, err.message], [422, 'GOV_HOLD_REASON_REQUIRED', 'Informe o motivo e a referência do processo.']); return true; });
  }
  for (const empty of [[], undefined, 'x']) {
    await assert.rejects(env.createHold(A(), { scope: empty }), (err) => { assert.deepEqual([err.statusCode || err.status, err.code, err.message], [422, 'GOV_HOLD_SCOPE_REQUIRED', 'Defina o escopo da retenção.']); return true; });
  }
  for (const bad of [[{ type: 'NADA' }], [{ type: 'PERSON', id: 'nao-e-uuid' }], [{ type: 'DATA_TYPE', entity_type: 'PERSON', from: '2026-13-40' }], [{ type: 'DATA_TYPE', entity_type: 'PERSON', from: '2026-05-02', to: '2026-05-01' }],
    [{ type: 'DATA_TYPE', entity_type: 'INTEGRATION', from: '2026-01-01' }], [{ type: 'ENTITY', entity_type: 'COMPANY', id: A().companyId }]]) {
    await rejects(env.createHold(A(), { scope: bad }), 422, 'GOV_HOLD_SCOPE_INVALID');
  }
  await rejects(env.createHold(A(), { scope: [{ type: 'PERSON', id: '00000000-0000-4000-8000-0000000000aa' }] }), 404, 'GOV_NOT_FOUND');
  assert.equal((await env.adminQuery('SELECT count(*)::int AS n FROM governance.legal_holds WHERE company_id = $1', [A().companyId])).rows[0].n, 0, 'nenhuma recusa gravou retenção');
});

test('m9d912 hold criado protege o escopo na hora e a liberação devolve o registro ao ciclo normal', { skip: env.skip() }, async () => {
  const person = await env.insertPerson(A());
  const other = await env.insertPerson(A());
  const hold = await env.createHold(A(), { scope: [{ type: 'PERSON', id: person }] });
  await rejects(env.assertNotOnHold(A(), 'PERSON', person), 409, 'GOV_HOLD_BLOCKS_DISPOSAL');
  await assert.rejects(env.assertNotOnHold(A(), 'PERSON', person), /Este registro está sob retenção legal e não pode ser apagado ou anonimizado\./);
  await env.assertNotOnHold(A(), 'PERSON', other); // quem não está no escopo segue livre
  await env.releaseHold(A(), hold.id);
  await env.assertNotOnHold(A(), 'PERSON', person);
});

test('m9d912 escopo: registro isolado, pessoa, contrato, processo, empresa inteira e tipo de dado com e sem período', { skip: env.skip() }, async () => {
  const person = await env.insertPerson(A());
  const contract = await env.insertContract(A(), person);
  const file = await env.insertFile(A(), { linkType: 'legal.contracts', linkId: contract });
  const standalone = await env.insertPerson(A());
  const hold = await env.createHold(A(), { scope: [{ type: 'CONTRACT', id: contract }, { type: 'ENTITY', entity_type: 'PERSON', id: standalone }] });
  const targets = await env.targetsOf(hold.id);
  assert.deepEqual(targets.map((t) => `${t.entity_type}:${t.entity_id}`).sort(), [`CONTRACT:${contract}`, `FILE:${file}`, `PERSON:${standalone}`].sort());
  assert.equal(targets.find((t) => t.entity_type === 'PERSON').origin, 'EXPLICIT');
  assert.equal(targets.find((t) => t.entity_type === 'FILE').origin, 'DERIVED');
  await env.releaseHold(A(), hold.id);
  const company = await env.createHold(A(), { scope: [{ type: 'COMPANY' }] });
  for (const [type, id] of [['PERSON', person], ['CONTRACT', contract], ['FILE', file], ['INTEGRATION', A().companyId]]) await rejects(env.assertNotOnHold(A(), type, id), 409, 'GOV_HOLD_BLOCKS_DISPOSAL');
  await env.assertNotOnHold(B(), 'PERSON', person); // a outra empresa não é afetada
  await env.releaseHold(A(), company.id);
  const type = await env.createHold(A(), { scope: [{ type: 'DATA_TYPE', entity_type: 'CONTRACT' }] });
  await rejects(env.assertNotOnHold(A(), 'CONTRACT', contract), 409, 'GOV_HOLD_BLOCKS_DISPOSAL');
  await env.assertNotOnHold(A(), 'PERSON', person);
  await env.releaseHold(A(), type.id);
  const period = await env.createHold(A(), { scope: [{ type: 'DATA_TYPE', entity_type: 'CONTRACT', from: '2020-01-01', to: '2020-12-31' }] });
  await env.assertNotOnHold(A(), 'CONTRACT', contract); // criado agora, fora de 2020
  await env.adminQuery("UPDATE legal.contracts SET created_at = '2020-06-15T12:00:00Z' WHERE id = $1", [contract]);
  await rejects(env.assertNotOnHold(A(), 'CONTRACT', contract), 409, 'GOV_HOLD_BLOCKS_DISPOSAL');
  await env.releaseHold(A(), period.id);
});

test('m9d912 criação e liberação auditam; a recusa de disposição fica na auditoria mesmo com a transação desfeita', { skip: env.skip() }, async () => {
  const person = await env.insertPerson(A());
  const hold = await env.createHold(A(), { scope: [{ type: 'PERSON', id: person }] });
  const created = (await env.auditRows(A(), 'governance.legal_hold.created')).filter((row) => row.entity_id === hold.id);
  assert.equal(created.length, 1);
  assert.equal(created[0].after_json.code, hold.code);
  assert.deepEqual(created[0].after_json.scope, [{ type: 'PERSON', id: person }]);
  await assert.rejects(env.assertNotOnHold(A(), 'PERSON', person));
  const blocked = (await env.auditRows(A(), 'governance.legal_hold.blocked')).filter((row) => row.entity_id === person);
  assert.equal(blocked.length >= 1, true, 'a recusa foi auditada fora da transação desfeita');
  await env.releaseHold(A(), hold.id, 'motivo de teste');
  const released = (await env.auditRows(A(), 'governance.legal_hold.released')).filter((row) => row.entity_id === hold.id);
  assert.deepEqual([released[0].before_json.status, released[0].after_json.status, released[0].after_json.releaseReason], ['ACTIVE', 'RELEASED', 'motivo de teste']);
});

test('m9d912 isolamento entre empresas: a retenção, o código e os alvos de uma não aparecem na outra', { skip: env.skip() }, async () => {
  const personA = await env.insertPerson(A());
  const c = code('ISO');
  const hold = await env.createHold(A(), { code: c, scope: [{ type: 'PERSON', id: personA }] });
  const listB = await env.withTx(B(), (tx) => env.holds.list(B(), {}, tx));
  assert.equal(listB.items.some((item) => item.id === hold.id), false);
  await rejects(env.withTx(B(), (tx) => env.holds.get(B(), hold.id, tx)), 404, 'GOV_NOT_FOUND');
  await rejects(env.withTx(B(), (tx) => env.holds.release(B(), { userId: B().userId }, hold.id, { release_reason: 'x' }, tx)), 404, 'GOV_NOT_FOUND');
  const seenByB = await env.withTx(B(), (tx) => env.guard.heldIds('PERSON', [personA], { tenant: B(), transaction: tx }));
  assert.deepEqual(seenByB, [], 'a empresa B não enxerga a retenção da A (RLS), nem pelo guarda');
  const own = await env.createHold(B(), { code: c, scope: [{ type: 'COMPANY' }] }); // o mesmo código em outra empresa é permitido
  assert.equal(own.code, c);
  await rejects(env.assertNotOnHold(A(), 'PERSON', personA), 409, 'GOV_HOLD_BLOCKS_DISPOSAL');
  const seenByA = await env.withTx(A(), (tx) => env.guard.heldIds('CONTRACT', [NONE], { tenant: A(), transaction: tx }));
  assert.deepEqual(seenByA, [], 'a retenção de empresa inteira da B não vale para a A');
  const rows = (await env.adminQuery('SELECT company_id FROM governance.legal_hold_targets WHERE hold_id = $1', [hold.id])).rows;
  assert.equal(rows.every((row) => row.company_id === A().companyId), true);
});

test('m9d912 o modelo no banco: tabelas com RLS FORCE, retenção ativa não se apaga e não se reescreve, liberada não reabre', { skip: env.skip() }, async () => {
  const person = await env.insertPerson(A());
  const hold = await env.createHold(A(), { scope: [{ type: 'PERSON', id: person }] });
  const cols = (await env.adminQuery("SELECT column_name FROM information_schema.columns WHERE table_schema = 'governance' AND table_name = 'legal_holds'")).rows.map((r) => r.column_name);
  for (const c of ['id', 'company_id', 'code', 'reason', 'matter_ref', 'scope', 'created_by', 'created_at', 'released_by', 'released_at', 'status', 'release_reason']) assert.ok(cols.includes(c), c);
  const tcols = (await env.adminQuery("SELECT column_name FROM information_schema.columns WHERE table_schema = 'governance' AND table_name = 'legal_hold_targets'")).rows.map((r) => r.column_name);
  for (const c of ['entity_type', 'entity_id', 'hold_id']) assert.ok(tcols.includes(c), c);
  await assert.rejects(env.adminQuery('DELETE FROM governance.legal_holds WHERE id = $1', [hold.id]), /não pode ser apagada/);
  await assert.rejects(env.adminQuery("UPDATE governance.legal_holds SET reason = 'outra' WHERE id = $1", [hold.id]), /não mudam/);
  await assert.rejects(env.adminQuery("UPDATE governance.legal_holds SET scope = '[{\"type\":\"COMPANY\"}]' WHERE id = $1", [hold.id]), /não mudam/);
  await env.releaseHold(A(), hold.id);
  await assert.rejects(env.adminQuery("UPDATE governance.legal_holds SET status = 'ACTIVE', released_at = NULL, release_reason = NULL WHERE id = $1", [hold.id]), /liberada não pode ser alterada/);
});
