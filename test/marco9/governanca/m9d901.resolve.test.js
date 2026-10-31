'use strict';

// M9-D901 — decisão humana sobre registros em quarentena e em revisão (POST /migration/records/:id/resolve): lista completa de decisões, motivo, RACI, aplicador da D900 e auditoria. Banco descartável.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const env = require('../_helpers/m9d901Env');

let tenants; let rUser; let oUser;
const skip = () => (env.DISPOSABLE ? false : env.SKIP_DISPOSABLE);
before(async () => { if (env.DISPOSABLE) { tenants = await env.loadTenants(); rUser = await env.committedUser(tenants.A); oUser = await env.committedUser(tenants.A); } });
after(async () => { if (env.DISPOSABLE) await env.cleanMigration(); await env.sequelize.close(); });
const A = () => tenants.A;
const accountable = () => ({ userId: A().userId, roles: [] });
const responsible = () => ({ userId: rUser.id, roles: ['FINANCEIRO'] });
const outsider = () => ({ userId: oUser.id, roles: ['OPERACIONAL'] });
const raciOk = () => env.setReconciliationRaci(A(), A().userId, [{ role: 'FINANCEIRO', raci: 'R' }]);
const valid = (extra = {}) => env.personRecord(extra);
const quarantined = (legacy, key, payload = valid({ legalName: '' })) => env.insertRecord(A(), legacy.system, 'PERSON', { key, state: 'QUARANTINED', payload, reason: 'Nome ausente ou com mais de 200 caracteres.' });
const review = (legacy, key) => env.insertRecord(A(), legacy.system, 'PERSON', { key, state: 'PENDING_REVIEW', payload: valid(), reason: 'Possível duplicata.' });

test('m9d901 REPROCESS tira o registro da quarentena, volta a PENDING e o blocker de quarentena sai quando quarantined chega a zero', { skip: skip() }, async () => {
  await raciOk();
  const legacy = await env.installSource(A(), { entity: 'PERSON' });
  legacy.fake.event('5', 'I', 1, valid({ legalName: '' }));
  await env.run(A(), { sourceSystem: legacy.system });
  const [rec] = await env.recordsOf(legacy.system);
  assert.equal(rec.state, 'QUARANTINED');
  const runId = await env.newRun(A(), legacy.system, 'PERSON');
  assert.ok((await env.getTower(A(), runId)).blockers.some((b) => b.code === 'GOV_MIG_QUARANTINE_OPEN'));
  legacy.fake.event('5', 'U', 2, valid()); // a origem corrige o dado: o registro segue em quarentena até a decisão
  await env.run(A(), { sourceSystem: legacy.system });
  assert.equal((await env.stateOf(rec.id)).state, 'QUARANTINED');
  const res = await env.resolve(A(), accountable(), rec.id, { decision: 'REPROCESS', reason: 'Dado corrigido na origem.' });
  assert.deepEqual([res.state, res.previous_state, res.decision], ['PENDING', 'QUARANTINED', 'REPROCESS']);
  const tower = await env.getTower(A(), runId);
  assert.deepEqual([tower.totals.quarantined, tower.totals.not_started], [0, 1]);
  assert.ok(!tower.blockers.some((b) => b.code === 'GOV_MIG_QUARANTINE_OPEN'), 'o blocker sai com a quarentena zerada');
  await env.run(A(), { sourceSystem: legacy.system }); // o próximo lote do aplicador da D900 pega o PENDING
  const done = await env.stateOf(rec.id);
  assert.equal(done.state, 'MIGRATED');
  assert.ok(done.target_entity_id, 'gravou o destino');
  const refs = await env.q("SELECT entity_id FROM core.external_refs WHERE source_system = $1 AND source_key = '5'", [legacy.system]);
  assert.equal(refs[0].entity_id, done.target_entity_id, 'o ID legado ficou ligado ao destino');
  legacy.dispose();
});

test('m9d901 REPROCESS que falha de novo retorna o registro a QUARANTINED', { skip: skip() }, async () => {
  await raciOk();
  const legacy = await env.installSource(A(), { entity: 'PERSON' });
  const rec = await quarantined(legacy, 'x1');
  await env.resolve(A(), accountable(), rec.id, { decision: 'REPROCESS', reason: 'Tentar de novo.' });
  assert.equal((await env.stateOf(rec.id)).state, 'PENDING');
  await env.run(A(), { sourceSystem: legacy.system });
  const again = await env.stateOf(rec.id);
  assert.equal(again.state, 'QUARANTINED');
  assert.match(again.reason, /Nome ausente/);
  legacy.dispose();
});

test('m9d901 REPROCESS sem motivo ou em registro fora de QUARANTINED é recusado', { skip: skip() }, async () => {
  await raciOk();
  const legacy = await env.installSource(A(), { entity: 'PERSON' });
  const rec = await quarantined(legacy, 'x2');
  for (const body of [{ decision: 'REPROCESS' }, { decision: 'REPROCESS', reason: '   ' }, { reason: 'sem decisão' }, null]) {
    const err = await env.fail(env.resolve(A(), accountable(), rec.id, body));
    assert.deepEqual([err.statusCode, err.code, err.message], [400, 'GOV_MIG_REASON_REQUIRED', 'Informe a decisão e o motivo.']);
  }
  assert.equal((await env.stateOf(rec.id)).state, 'QUARANTINED');
  const migrated = await env.insertRecord(A(), legacy.system, 'PERSON', { key: 'm1', state: 'MIGRATED', payload: valid() });
  const err = await env.fail(env.resolve(A(), accountable(), migrated.id, { decision: 'REPROCESS', reason: 'não cabe' }));
  assert.deepEqual([err.statusCode, err.code], [409, 'GOV_MIG_RECORD_INVALID_TRANSITION']);
  const missing = await env.fail(env.resolve(A(), accountable(), env.randomUUID(), { decision: 'REPROCESS', reason: 'x' }));
  assert.equal(missing.statusCode, 404);
  legacy.dispose();
});

test('m9d901 EXCLUDE por quem não é A da reconciliação final devolve 403 e por A leva a EXCLUDED', { skip: skip() }, async () => {
  await raciOk();
  const legacy = await env.installSource(A(), { entity: 'PERSON' });
  const rec = await quarantined(legacy, 'x3');
  const byR = await env.fail(env.resolve(A(), responsible(), rec.id, { decision: 'EXCLUDE', reason: 'CPF impossível.' }));
  assert.deepEqual([byR.statusCode, byR.code], [403, 'GOV_MIG_RACI_FORBIDDEN']);
  const byOutsider = await env.fail(env.resolve(A(), outsider(), rec.id, { decision: 'REPROCESS', reason: 'x' }));
  assert.deepEqual([byOutsider.statusCode, byOutsider.code], [403, 'GOV_MIG_RACI_FORBIDDEN']);
  assert.equal((await env.stateOf(rec.id)).state, 'QUARANTINED', 'recusas não mexem no registro');
  const ok = await env.resolve(A(), accountable(), rec.id, { decision: 'EXCLUDE', reason: 'CPF impossível, cadastro de teste.' });
  assert.equal(ok.state, 'EXCLUDED');
  const row = await env.stateOf(rec.id);
  assert.match(row.reason, /CPF impossível/);
  const viaR = await env.resolve(A(), responsible(), (await quarantined(legacy, 'x3b')).id, { decision: 'SEND_TO_REVIEW', reason: 'Dúvida.' });
  assert.equal(viaR.state, 'PENDING_REVIEW', 'R pode decidir o que não é descarte');
  legacy.dispose();
});

test('m9d901 sem RACI definido ninguém resolve', { skip: skip() }, async () => {
  await env.setRaci(A(), env.ACTIVITY, []);
  const legacy = await env.installSource(A(), { entity: 'PERSON' });
  const rec = await quarantined(legacy, 'x4');
  const err = await env.fail(env.resolve(A(), accountable(), rec.id, { decision: 'REPROCESS', reason: 'x' }));
  assert.equal(err.code, 'GOV_MIG_RACI_FORBIDDEN');
  legacy.dispose();
});

test('m9d901 cada decisão da lista leva ao estado esperado e valor fora da lista devolve 409', { skip: skip() }, async () => {
  await raciOk();
  const legacy = await env.installSource(A(), { entity: 'PERSON' });
  const run = async (rec, decision) => (await env.resolve(A(), accountable(), rec.id, { decision, reason: `Decisão ${decision}.` })).state;
  assert.equal(await run(await quarantined(legacy, 'd1'), 'REPROCESS'), 'PENDING');
  assert.equal(await run(await quarantined(legacy, 'd2'), 'SEND_TO_REVIEW'), 'PENDING_REVIEW');
  assert.equal(await run(await quarantined(legacy, 'd3'), 'EXCLUDE'), 'EXCLUDED');
  assert.equal(await run(await review(legacy, 'd4'), 'APPROVE'), 'MIGRATED');
  assert.equal(await run(await review(legacy, 'd5'), 'QUARANTINE'), 'QUARANTINED');
  assert.equal(await run(await review(legacy, 'd6'), 'EXCLUDE'), 'EXCLUDED');
  for (const [rec, decision] of [[await quarantined(legacy, 'e1'), 'APPROVE'], [await quarantined(legacy, 'e2'), 'QUARANTINE'], [await review(legacy, 'e3'), 'REPROCESS'], [await review(legacy, 'e4'), 'SEND_TO_REVIEW'], [await quarantined(legacy, 'e5'), 'FOO']]) {
    const err = await env.fail(env.resolve(A(), accountable(), rec.id, { decision, reason: 'fora da lista' }));
    assert.deepEqual([err.statusCode, err.code], [409, 'GOV_MIG_RECORD_INVALID_TRANSITION'], `${decision}`);
  }
  legacy.dispose();
});

test('m9d901 APPROVE aplica o registro pelo aplicador da D900 e liga o ID legado; dado inválido não é aprovado', { skip: skip() }, async () => {
  await raciOk();
  const legacy = await env.installSource(A(), { entity: 'PERSON' });
  const rec = await review(legacy, 'a1');
  const res = await env.resolve(A(), accountable(), rec.id, { decision: 'APPROVE', reason: 'Não é duplicata: homônimo.' });
  assert.equal(res.state, 'MIGRATED');
  const row = await env.stateOf(rec.id);
  const [person] = await env.q('SELECT legal_name FROM people.persons WHERE id = $1', [row.target_entity_id]);
  assert.equal(person.legal_name, rec.source_payload.legalName);
  const refs = await env.q("SELECT entity_type, entity_id FROM core.external_refs WHERE source_system = $1 AND source_key = 'a1' AND valid_to IS NULL", [legacy.system]);
  assert.deepEqual([refs[0].entity_type, refs[0].entity_id], ['PERSON', row.target_entity_id]);
  const bad = await env.insertRecord(A(), legacy.system, 'PERSON', { key: 'a2', state: 'PENDING_REVIEW', payload: valid({ legalName: '' }), reason: 'Revisão.' });
  const err = await env.fail(env.resolve(A(), accountable(), bad.id, { decision: 'APPROVE', reason: 'Aprovar assim mesmo.' }));
  assert.deepEqual([err.statusCode, err.code], [422, 'GOV_MIG_RECORD_UNAPPLICABLE']);
  assert.equal((await env.stateOf(bad.id)).state, 'PENDING_REVIEW');
  legacy.dispose();
});

test('m9d901 cada transição é auditada com antes e depois e a repetida devolve 409 sem efeito', { skip: skip() }, async () => {
  await raciOk();
  const legacy = await env.installSource(A(), { entity: 'PERSON' });
  const rec = await quarantined(legacy, 'u1');
  await env.resolve(A(), accountable(), rec.id, { decision: 'SEND_TO_REVIEW', reason: 'Mandar para revisão.' });
  const audit = await env.q("SELECT before_json, after_json, reason, user_id FROM audit.audit_log WHERE entity_id = $1 AND action = 'migration.record.resolved'", [rec.id]);
  assert.equal(audit.length, 1);
  assert.deepEqual([audit[0].before_json.state, audit[0].after_json.state, audit[0].after_json.decision], ['QUARANTINED', 'PENDING_REVIEW', 'SEND_TO_REVIEW']);
  assert.equal(audit[0].user_id, A().userId);
  const again = await env.fail(env.resolve(A(), accountable(), rec.id, { decision: 'SEND_TO_REVIEW', reason: 'De novo.' }));
  assert.equal(again.code, 'GOV_MIG_RECORD_INVALID_TRANSITION');
  assert.equal((await env.q("SELECT count(*)::int AS n FROM audit.audit_log WHERE entity_id = $1 AND action = 'migration.record.resolved'", [rec.id]))[0].n, 1);
  legacy.dispose();
});
