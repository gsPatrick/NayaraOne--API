'use strict';

// M9-D805 — decisão da fila: união com referências reapontadas, atomicidade, isolamento, guard de evidência e erros. Banco descartável (ver m9d805.deteccao.test.js).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const env = require('../_helpers/m9d805Env');
const mergeService = require('../../../src/features/core-governance/data-quality/merge.service');
const references = require('../../../src/features/core-governance/data-quality/merge.references');
const { adminQuery } = require('../../m9d801.helpers');

let tenants;
const skip = () => (env.DISPOSABLE ? false : env.SKIP_DISPOSABLE);
before(async () => { if (env.DISPOSABLE) tenants = await env.loadTenants(); });
after(async () => { await env.sequelize.close(); });
const A = () => tenants.A;
const run = (fn) => env.withRollbackTenantTransaction(tenants.A, fn);
const fail = (promise) => promise.then(() => null, (err) => err);
const decide = (actor, id, body, tx) => mergeService.decide(A(), actor, id, body, tx);
const EVIDENCE = { source: 'OTHER', note: 'Escolha do steward conferida com o cartório.' };
const personRow = async (id, tx) => (await env.query('SELECT status, merged_into_id, legal_name FROM people.persons WHERE id = :id', { id }, tx))[0];

async function personPair(tx, a = {}, b = {}) {
  const first = await env.person(A(), tx, { legalName: 'Maria Souza Prado', ...a });
  const second = await env.person(A(), tx, { legalName: 'Maria Souza Prado', ...b });
  const item = await env.candidate(A(), tx, 'PERSON', first.id, second.id);
  return { first, second, item };
}

test('m9d805 união reaponta referências em transação', { skip: skip() }, async () => {
  await run(async (tx) => {
    const { first, second, item } = await personPair(tx);
    const { actor } = await env.steward(A(), tx);
    const property = await env.property(A(), tx);
    const account = await env.bankAccount(A(), tx, second.id);
    const file = await env.file(A(), tx);
    await env.query('INSERT INTO real_estate.property_owners (id, group_id, company_id, property_id, person_id, role_code, created_at, updated_at) VALUES (gen_random_uuid(), :g, :c, :p, :o, \'OWNER\', now(), now()) RETURNING id',
      { g: A().groupId, c: A().companyId, p: property.id, o: second.id }, tx);
    const feedback = await env.feedbackCase(A(), tx, second.id);
    await env.fileLink(A(), tx, file.id, 'Person', second.id);
    const survivor = [first, second].find((p) => p.id === item.primary_id);
    const absorbed = [first, second].find((p) => p.id !== item.primary_id);
    // as referências do ABSORVIDO é que se movem: recoloca-as no cadastro que vai sair
    await env.query('UPDATE finance.bank_accounts SET owner_person_id = :o WHERE id = :id', { o: absorbed.id, id: account.id }, tx);
    await env.query('UPDATE real_estate.property_owners SET person_id = :o WHERE property_id = :p', { o: absorbed.id, p: property.id }, tx);
    await env.query('UPDATE crm.feedback_cases SET person_id = :o WHERE id = :id', { o: absorbed.id, id: feedback }, tx);
    await env.query('UPDATE people.file_links SET related_entity_id = :o WHERE file_id = :f', { o: absorbed.id, f: file.id }, tx);
    const done = await decide(actor, item.id, { decision: 'MERGED', survivorId: survivor.id, note: 'Mesma pessoa.' }, tx);
    assert.deepEqual([done.status, done.survivorId, done.decidedBy, done.assignedStewardId], ['MERGED', survivor.id, actor.userId, actor.userId]);
    const merged = await personRow(absorbed.id, tx);
    assert.deepEqual([merged.status, merged.merged_into_id], ['MERGED', survivor.id], 'o absorvido nunca é apagado');
    assert.equal((await env.query('SELECT owner_person_id FROM finance.bank_accounts WHERE id = :id', { id: account.id }, tx))[0].owner_person_id, survivor.id);
    assert.equal((await env.query('SELECT person_id FROM real_estate.property_owners WHERE property_id = :p', { p: property.id }, tx))[0].person_id, survivor.id);
    assert.equal((await env.query('SELECT person_id FROM crm.feedback_cases WHERE id = :id', { id: feedback }, tx))[0].person_id, survivor.id, 'FK que o serviço de pessoas não cobria também seguiu');
    assert.equal((await env.query('SELECT related_entity_id FROM people.file_links WHERE file_id = :f', { f: file.id }, tx))[0].related_entity_id, survivor.id);
    assert.ok(done.evidence.moved['crm.feedback_cases.person_id'] >= 1, 'o mapa de referências fica na decisão');
    const audit = await env.query("SELECT action FROM audit.audit_log WHERE entity_id = :id AND action LIKE 'governance.review_queue.%'", { id: item.id }, tx);
    assert.deepEqual(audit.map((a) => a.action), ['governance.review_queue.merged']);
  });
});

test('m9d805 união de fornecedores reaponta compras e imóveis ganham merged_into_id', { skip: skip() }, async () => {
  await run(async (tx) => {
    const s1 = await env.supplier(A(), tx, { legalName: 'Fornecedor Gama' });
    const s2 = await env.supplier(A(), tx, { legalName: 'Fornecedor Gama' });
    const supplierItem = await env.candidate(A(), tx, 'SUPPLIER', s1.id, s2.id, { reason: 'SUPPLIER_NAME', score: 80 });
    const out = supplierItem.primary_id === s1.id ? s2 : s1;
    const evaluation = await env.supplierEvaluation(A(), tx, out.id);
    const { actor } = await env.steward(A(), tx);
    await decide(actor, supplierItem.id, { decision: 'MERGED', survivorId: supplierItem.primary_id }, tx);
    assert.equal((await env.query('SELECT supplier_person_id FROM procurement.supplier_evaluations WHERE id = :id', { id: evaluation }, tx))[0].supplier_person_id, supplierItem.primary_id);
    const p1 = await env.property(A(), tx);
    const p2 = await env.property(A(), tx);
    const propItem = await env.candidate(A(), tx, 'PROPERTY', p1.id, p2.id, { reason: 'PROPERTY_REGISTRY', score: 95 });
    const gone = propItem.primary_id === p1.id ? p2 : p1;
    await decide(actor, propItem.id, { decision: 'MERGED', survivorId: propItem.primary_id }, tx);
    const row = (await env.query('SELECT merged_into_id, availability_status FROM real_estate.properties WHERE id = :id', { id: gone.id }, tx))[0];
    assert.deepEqual([row.merged_into_id, row.availability_status], [propItem.primary_id, 'WITHDRAWN']);
  });
});

test('m9d805 falha no meio desfaz a união inteira', { skip: skip() }, async () => {
  await run(async (tx) => {
    const { first, second, item } = await personPair(tx);
    const { actor } = await env.steward(A(), tx);
    const account = await env.bankAccount(A(), tx, item.primary_id === first.id ? second.id : first.id);
    await env.sequelize.query('SAVEPOINT m9d805_atomico', { transaction: tx });
    const original = references.remapLeftovers;
    references.remapLeftovers = async () => { throw new Error('falha no meio da união'); };
    let err;
    try { err = await fail(decide(actor, item.id, { decision: 'MERGED', survivorId: item.primary_id }, tx)); } finally { references.remapLeftovers = original; }
    assert.equal(err.message, 'falha no meio da união');
    await env.sequelize.query('ROLLBACK TO SAVEPOINT m9d805_atomico', { transaction: tx });
    const other = item.primary_id === first.id ? second : first;
    assert.equal((await personRow(other.id, tx)).status, 'ACTIVE', 'o absorvido continua ativo');
    assert.equal((await env.query('SELECT owner_person_id FROM finance.bank_accounts WHERE id = :id', { id: account.id }, tx))[0].owner_person_id, other.id, 'a referência não se moveu');
    assert.equal((await env.queueRows(A(), tx, 'id = :id', { id: item.id }))[0].status, 'OPEN', 'a passagem por IN_REVIEW também foi desfeita');
  });
});

test('m9d805 união de empresas diferentes recusada', { skip: skip() }, async () => {
  const { rows: [foreign] } = await adminQuery(
    `INSERT INTO people.persons (id, group_id, company_id, person_type, legal_name, status) VALUES (gen_random_uuid(), $1, $2, 'PF', 'QA-M9 Pessoa Outra Empresa', 'ACTIVE') RETURNING id`,
    [tenants.B.groupId, tenants.B.companyId]
  );
  try {
    await run(async (tx) => {
      const mine = await env.person(A(), tx);
      const item = await env.candidate(A(), tx, 'PERSON', mine.id, foreign.id);
      const { actor } = await env.steward(A(), tx);
      const err = await fail(decide(actor, item.id, { decision: 'MERGED', survivorId: mine.id }, tx));
      assert.equal(err.statusCode, 404);
      assert.equal(err.code, 'GOV_NOT_FOUND');
      assert.equal(err.message, 'Registro não encontrado.');
      assert.equal((await env.query('SELECT status FROM people.persons WHERE id = :id', { id: mine.id }, tx))[0].status, 'ACTIVE');
    });
  } finally {
    await adminQuery('DELETE FROM people.persons WHERE id = $1', [foreign.id]);
  }
});

test('m9d805 união usa o guard de evidência de M9-D807 para os campos conflitantes', { skip: skip() }, async () => {
  await run(async (tx) => {
    const { first, second, item } = await personPair(tx, { legalName: 'Maria Souza Prado' }, { legalName: 'Maria de Souza Prado' });
    const { actor } = await env.steward(A(), tx);
    const survivorId = item.primary_id;
    const other = [first, second].find((p) => p.id !== survivorId);
    const pending = await fail(decide(actor, item.id, { decision: 'MERGED', survivorId }, tx));
    assert.equal(pending.statusCode, 400);
    assert.equal(pending.code, 'GOV_MERGE_FIELD_CHOICE_REQUIRED');
    assert.deepEqual(pending.details.fields, ['legalName']);
    const noEvidence = await fail(decide(actor, item.id, { decision: 'MERGED', survivorId, fieldChoices: { legalName: 'OTHER' } }, tx));
    assert.equal(noEvidence.code, 'GOV_EVIDENCE_REQUIRED', 'trocar o nome do sobrevivente pelo do outro é alteração de campo crítico');
    assert.equal((await personRow(other.id, tx)).status, 'ACTIVE', 'nada foi gravado');
    const ok = await decide(actor, item.id, { decision: 'MERGED', survivorId, fieldChoices: { legalName: 'OTHER' }, evidence: EVIDENCE }, tx);
    assert.equal(ok.status, 'MERGED');
    assert.equal((await personRow(survivorId, tx)).legal_name, other.legalName, 'o sobrevivente ficou com o nome escolhido');
    const rows = await env.evidenceRows(survivorId, tx);
    assert.deepEqual(rows.map((r) => [r.entity_type, r.field, r.source]), [['PERSON', 'legalName', 'OTHER']]);
    assert.deepEqual(ok.evidence.fieldChoices, { legalName: 'OTHER' });
  });
  await run(async (tx) => {
    const { first, item } = await personPair(tx, { legalName: 'Joana Lima' }, { legalName: 'Joana de Lima' });
    const { actor } = await env.steward(A(), tx);
    const keep = await decide(actor, item.id, { decision: 'MERGED', survivorId: item.primary_id, fieldChoices: { legalName: 'SURVIVOR' } }, tx);
    assert.equal(keep.status, 'MERGED', 'manter o valor do sobrevivente não altera campo e não pede evidência');
    assert.ok(first);
  });
});

test('m9d805 decisão devolve 400, 403 e 409 conforme a tabela de erros', { skip: skip() }, async () => {
  await run(async (tx) => {
    const { first, second, item } = await personPair(tx);
    const { actor } = await env.steward(A(), tx, ['IMOVEIS']);
    const outsider = await fail(decide(actor, item.id, { decision: 'DISMISSED' }, tx));
    assert.equal(outsider.statusCode, 403);
    assert.equal(outsider.code, 'GOV_NOT_DOMAIN_STEWARD');
    assert.equal(outsider.message, 'Você não é responsável por este domínio.');
    const { actor: stewardActor } = await env.steward(A(), tx, ['PESSOAS']);
    const wrong = await fail(decide(stewardActor, item.id, { decision: 'TALVEZ' }, tx));
    assert.deepEqual([wrong.statusCode, wrong.code, wrong.message], [400, 'GOV_QUEUE_DECISION_INVALID', 'Decisão inválida para este item.']);
    const stranger = await env.person(A(), tx);
    const survivor = await fail(decide(stewardActor, item.id, { decision: 'MERGED', survivorId: stranger.id }, tx));
    assert.deepEqual([survivor.statusCode, survivor.code, survivor.message], [400, 'GOV_MERGE_SURVIVOR_INVALID', 'O registro mantido deve ser um dos dois do par.']);
    assert.equal((await fail(decide(stewardActor, item.id, { decision: 'MERGED' }, tx))).code, 'GOV_MERGE_SURVIVOR_INVALID');
    const done = await decide(stewardActor, item.id, { decision: 'KEPT_SEPARATE', note: 'São primas.' }, tx);
    assert.deepEqual([done.status, done.assignedStewardId, done.decisionNote], ['KEPT_SEPARATE', stewardActor.userId, 'São primas.']);
    for (const body of [{ decision: 'KEPT_SEPARATE' }, { decision: 'MERGED', survivorId: first.id }, { decision: 'DISMISSED' }]) {
      const again = await fail(decide(stewardActor, item.id, body, tx));
      assert.deepEqual([again.statusCode, again.code, again.message], [409, 'GOV_QUEUE_ITEM_FINAL', 'Este item já foi decidido.'], 'estado final não sai nem repete');
    }
    const missing = await fail(decide(stewardActor, env.randomUUID(), { decision: 'DISMISSED' }, tx));
    assert.equal(missing.statusCode, 404);
    assert.equal((await fail(decide(stewardActor, 'nao-e-uuid', { decision: 'DISMISSED' }, tx))).statusCode, 404);
    assert.ok(second);
  });
});

test('m9d805 MERGED em kind REVIEW devolve 400', { skip: skip() }, async () => {
  await run(async (tx) => {
    const person = await env.person(A(), tx);
    const { actor } = await env.steward(A(), tx);
    const detection = require('../../../src/features/core-governance/data-quality/merge.detection');
    const review = await detection.openReviewItem(A(), { entityType: 'PERSON', entityId: person.id, reason: 'QUALITY_CRITICAL', score: 100 }, tx);
    assert.deepEqual([review.kind, review.secondary_id, review.status], ['REVIEW', null, 'OPEN']);
    assert.equal(await detection.openReviewItem(A(), { entityType: 'PERSON', entityId: person.id, reason: 'QUALITY_CRITICAL' }, tx), null, 'um REVIEW aberto por cadastro');
    for (const body of [{ decision: 'MERGED', survivorId: person.id }, { decision: 'KEPT_SEPARATE' }]) {
      const err = await fail(decide(actor, review.id, body, tx));
      assert.deepEqual([err.statusCode, err.code], [400, 'GOV_QUEUE_DECISION_INVALID']);
    }
    const dismissed = await decide(actor, review.id, { decision: 'DISMISSED', note: 'Falso alarme.' }, tx);
    assert.equal(dismissed.status, 'DISMISSED');
    const second = await detection.openReviewItem(A(), { entityType: 'PERSON', entityId: person.id, reason: 'QUALITY_CRITICAL' }, tx);
    assert.ok(second, 'depois de decidido o cadastro pode voltar para revisão');
  });
});

test('m9d805 par decidido como KEPT_SEPARATE ou DISMISSED não volta na detecção noturna', { skip: skip() }, async () => {
  await run(async (tx) => {
    const detection = require('../../../src/features/core-governance/data-quality/merge.detection');
    const cpf = env.cpf();
    const kept = await personPair(tx, { taxIdNormalized: cpf }, { taxIdNormalized: `${cpf}-` });
    const cpf2 = env.cpf();
    const dropped = await personPair(tx, { taxIdNormalized: cpf2 }, { taxIdNormalized: `${cpf2}-` });
    const { actor } = await env.steward(A(), tx);
    await decide(actor, kept.item.id, { decision: 'KEPT_SEPARATE' }, tx);
    await decide(actor, dropped.item.id, { decision: 'DISMISSED' }, tx);
    const summary = await detection.runDetection(A(), tx, { entityTypes: ['PERSON'] });
    const rows = (await env.queueRows(A(), tx)).filter((r) => [kept.first.id, dropped.first.id].includes(r.primary_id) || [kept.first.id, dropped.first.id].includes(r.secondary_id));
    assert.deepEqual(rows.map((r) => r.status).sort(), ['DISMISSED', 'KEPT_SEPARATE'], 'nenhuma linha nova para os dois pares');
    assert.ok(summary.detected >= 0);
  });
});
