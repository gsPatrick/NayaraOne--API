'use strict';

// M9-D907 — inventário das operações externas (governance.external_op_types): semente, PUT com compensação e responsável obrigatórios, operação de envio em um só tipo e a Torre.
// Banco descartável.
const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const env = require('../_helpers/m9d907Env');

let A;
const skip = () => (env.DISPOSABLE ? false : env.SKIP_DISPOSABLE);
before(async () => { if (env.DISPOSABLE) { A = (await env.loadTenants()).A; await env.cleanup(A); } });
afterEach(async () => { if (env.DISPOSABLE) await env.cleanup(A); });
// A auditoria é só de acréscimo e o cleanup não a apaga (R4-L2): cada teste conta só o que ele mesmo gerou, a partir do instante do banco em que começou, e passa em qualquer passada no mesmo banco.
const since = async () => (await env.adminQuery('SELECT clock_timestamp() AS t')).rows[0].t;
after(async () => { await env.sequelize.close(); });

test('m9d907 inventário semeado cobre as saídas externas, cada tipo com compensação, procedimento e responsável', { skip: skip() }, async () => {
  const { types } = await env.listTypes(A);
  const by = Object.fromEntries(types.map((t) => [t.code, t]));
  assert.deepEqual(Object.keys(by).sort(), ['BILLING_ISSUED', 'FINANCING_PROPOSAL_SENT', 'FISCAL_OBLIGATION_TRANSMITTED', 'INSURANCE_PROPOSAL_SENT', 'MESSAGE_SENT', 'PAYMENT_SENT', 'PUBLICATION_PUBLISHED', 'SIGNATURE_ENVELOPE_SENT']);
  assert.deepEqual(['PAYMENT_SENT', 'MESSAGE_SENT', 'SIGNATURE_ENVELOPE_SENT', 'FISCAL_OBLIGATION_TRANSMITTED'].map((c) => by[c].reversibility), Array(4).fill('IRREVERSIBLE'));
  assert.deepEqual(['BILLING_ISSUED', 'FINANCING_PROPOSAL_SENT', 'PUBLICATION_PUBLISHED'].map((c) => by[c].reversibility), Array(3).fill('COMPENSABLE'));
  for (const t of types) assert.ok(t.compensation && t.procedure && t.owner, `${t.code} sem plano completo`);
  assert.match(by.PAYMENT_SENT.compensation, /estorno/i);
  assert.ok(by.PAYMENT_SENT.operations.includes('submitPayment') && by.MESSAGE_SENT.operations.includes('sendText'));
  assert.equal((await env.towerBlockers(A, 'GOV_ROLLBACK_COMPENSATION_REQUIRED')).length, 0, 'semente completa não abre blocker');
});

test('m9d907 PUT sem compensação é 422 GOV_ROLLBACK_COMPENSATION_REQUIRED e nada é gravado', { skip: skip() }, async () => {
  await env.listTypes(A);
  for (const bad of [{ compensation: '' }, { compensation: '   ' }, { procedure: '' }]) {
    const err = await env.fail(env.putTypes(A, [env.goodType('QA907_BOM'), env.goodType('QA907_RUIM', bad)]));
    assert.deepEqual([err.status, err.code, err.message], [422, 'GOV_ROLLBACK_COMPENSATION_REQUIRED', 'Defina o procedimento de compensação deste tipo de operação.'], JSON.stringify(bad));
    assert.equal(err.details.code, 'QA907_RUIM');
  }
  const codes = (await env.listTypes(A)).types.map((t) => t.code);
  assert.ok(!codes.includes('QA907_BOM') && !codes.includes('QA907_RUIM'), 'todos ou nenhum');
  const noOwner = await env.fail(env.putTypes(A, [env.goodType('QA907_SEM_DONO', { owner: '' })]));
  assert.deepEqual([noOwner.status, noOwner.code], [422, 'GOV_ROLLBACK_INVALID']);
  const badKind = await env.fail(env.putTypes(A, [env.goodType('QA907_X', { reversibility: 'MAYBE' })]));
  assert.equal(badKind.code, 'GOV_ROLLBACK_INVALID');
});

test('m9d907 PUT grava, atualiza e audita o antes e o depois; o tipo reversível dispensa só o procedimento', { skip: skip() }, async () => {
  const start = await since();
  await env.putTypes(A, [env.goodType('QA907_A', { operations: ['qa907OpA'] })]);
  const first = (await env.listTypes(A)).types.find((t) => t.code === 'QA907_A');
  assert.deepEqual([first.reversibility, first.owner, first.operations, first.entity], ['IRREVERSIBLE', 'QA-M9', ['qa907OpA'], 'QA907_ENTITY']);
  await env.putTypes(A, [env.goodType('QA907_A', { reversibility: 'REVERSIBLE', procedure: '', compensation: 'Desfaz sozinho.', owner: 'TI' })]);
  const after = (await env.listTypes(A)).types.find((t) => t.code === 'QA907_A');
  assert.deepEqual([after.reversibility, after.owner, after.operations], ['REVERSIBLE', 'TI', ['qa907OpA']], 'sem informar operations, as ligações ficam');
  const audits = (await env.adminQuery("SELECT * FROM audit.audit_log WHERE company_id = $1 AND action = 'migration.external_op_type.saved' AND after_json->>'code' = 'QA907_A' AND occurred_at >= $2 ORDER BY occurred_at", [A.companyId, start])).rows;
  assert.equal(audits.length, 2);
  assert.equal(audits[0].before_json, null);
  assert.equal(audits[1].before_json.reversibility, 'IRREVERSIBLE');
  assert.equal(audits[1].after_json.reversibility, 'REVERSIBLE');
});

test('m9d907 uma operação de envio pertence a um só tipo', { skip: skip() }, async () => {
  await env.putTypes(A, [env.goodType('QA907_A', { operations: ['qa907Dup'] })]);
  const err = await env.fail(env.putTypes(A, [env.goodType('QA907_B', { operations: ['qa907Dup'] })]));
  assert.deepEqual([err.status, err.code], [422, 'GOV_ROLLBACK_INVALID']);
  const both = await env.fail(env.putTypes(A, [env.goodType('QA907_C', { operations: ['qa907Z'] }), env.goodType('QA907_D', { operations: ['qa907Z'] })]));
  assert.equal(both.code, 'GOV_ROLLBACK_INVALID');
  const moved = await env.putTypes(A, [env.goodType('QA907_A', { operations: [] }), env.goodType('QA907_B', { operations: ['qa907Dup'] })]);
  assert.equal(moved.types.length, 2, 'mover a operação de um tipo para outro na mesma chamada vale');
});

test('m9d907 tipo sem compensação gera blocker na Torre e o fecha quando o plano é cadastrado', { skip: skip() }, async () => {
  const start = await since();
  await env.listTypes(A);
  await env.adminQuery("INSERT INTO governance.external_op_types (group_id, company_id, code, module, reversibility, entity) VALUES ($1, $2, 'QA907_SEM_PLANO', 'QA', 'IRREVERSIBLE', 'QA907_ENTITY')", [A.groupId, A.companyId]);
  const open = await env.towerBlockers(A, 'GOV_ROLLBACK_COMPENSATION_REQUIRED');
  assert.deepEqual(open.map((b) => [b.entity, b.ref, b.detail.type, b.detail.missing]), [['QA907_ENTITY', 'type:QA907_SEM_PLANO', 'QA907_SEM_PLANO', ['compensation', 'procedure', 'owner']]]);
  await env.putTypes(A, [env.goodType('QA907_SEM_PLANO')]);
  assert.equal((await env.towerBlockers(A, 'GOV_ROLLBACK_COMPENSATION_REQUIRED')).length, 0, 'plano cadastrado fecha o blocker');
  const trail = (await env.adminQuery("SELECT action FROM audit.audit_log WHERE company_id = $1 AND action IN ('migration.blocker.opened', 'migration.blocker.closed') AND after_json->>'code' = 'GOV_ROLLBACK_COMPENSATION_REQUIRED' AND occurred_at >= $2 ORDER BY occurred_at", [A.companyId, start])).rows.map((r) => r.action);
  assert.deepEqual(trail, ['migration.blocker.opened', 'migration.blocker.closed']);
});

test('m9d907 o GO só vale com todos os tipos com plano (409 GOV_CUTOVER_NOT_READY) e decisão inválida é 422', { skip: skip() }, async () => {
  await env.listTypes(A);
  await env.adminQuery("INSERT INTO governance.external_op_types (group_id, company_id, code, module, reversibility) VALUES ($1, $2, 'QA907_SEM_PLANO', 'QA', 'COMPENSABLE')", [A.groupId, A.companyId]);
  const blocked = await env.fail(env.decide(A, 'GO'));
  assert.deepEqual([blocked.status, blocked.code], [409, 'GOV_CUTOVER_NOT_READY']);
  assert.equal(blocked.details.gaps[0].detail.type, 'QA907_SEM_PLANO');
  assert.equal((await env.adminQuery('SELECT 1 FROM governance.cutover_decisions WHERE company_id = $1', [A.companyId])).rows.length, 0);
  assert.equal((await env.fail(env.decide(A, 'TALVEZ'))).code, 'GOV_CUTOVER_DECISION_INVALID');
  const nogo = await env.decide(A, 'NO_GO', { reason: 'Falta o plano.' });
  assert.deepEqual([nogo.decision, nogo.t0], ['NO_GO', null]);
  await env.putTypes(A, [env.goodType('QA907_SEM_PLANO')]);
  const go = await env.decide(A, 'GO');
  assert.deepEqual([go.decision, go.t0 instanceof Date], ['GO', true]);
});
