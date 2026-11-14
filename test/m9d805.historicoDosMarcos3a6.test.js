'use strict';

// Integração dos Marcos 3 a 6 sobre o Marco 9 (14/11/2026): a união de cadastros do Marco 9 (M9-D805) reaponta toda FK do cadastro absorvido.
// Os Marcos 3 e 5 trouxeram histórico imutável por gatilho (assinatura de aditivo, garantia substituída, rastro do radar e do carrinho):
// essas linhas NÃO são reescritas, ficam no cadastro absorvido (que continua existindo, com merged_into_id para o sobrevivente), e a união
// não falha por causa delas. O que não é histórico (a garantia vigente) segue o sobrevivente. Banco descartável, transação desfeita.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const env = require('./marco9/_helpers/m9d805Env');
const mergeService = require('../src/features/core-governance/data-quality/merge.service');
const references = require('../src/features/core-governance/data-quality/merge.references');

let tenants;
const skip = () => (env.DISPOSABLE ? false : env.SKIP_DISPOSABLE);
before(async () => { if (env.DISPOSABLE) tenants = await env.loadTenants(); });
after(async () => { await env.sequelize.close(); });
const A = () => tenants.A;

test('união de pessoas com assinatura de aditivo e garantia substituída: o histórico fica no absorvido, a garantia vigente segue o sobrevivente', { skip: skip() }, async () => {
  await env.withRollbackTenantTransaction(A(), async (tx) => {
    const first = await env.person(A(), tx, { legalName: 'Joana Lima Prado' });
    const second = await env.person(A(), tx, { legalName: 'Joana Lima Prado' });
    const item = await env.candidate(A(), tx, 'PERSON', first.id, second.id);
    const { actor } = await env.steward(A(), tx);
    const survivor = [first, second].find((p) => p.id === item.primary_id);
    const absorbed = [first, second].find((p) => p.id !== item.primary_id);
    const r = { g: A().groupId, c: A().companyId, u: A().userId, p: absorbed.id };
    const [{ id: contrato }] = await env.query(`INSERT INTO legal.contracts (id, group_id, company_id, contract_type, status, created_by, created_at, updated_at)
      VALUES (gen_random_uuid(), :g, :c, 'LEASE_RESIDENTIAL', 'DRAFT', :u, now(), now()) RETURNING id`, r, tx);
    const [{ id: aditivo }] = await env.query(`INSERT INTO legal.addenda (id, group_id, company_id, contract_id, amendment_number, reason, changes_json, status, effective_from, created_by, created_at)
      VALUES (gen_random_uuid(), :g, :c, :k, 1, 'Aditivo assinado', '{}'::jsonb, 'DRAFT', current_date, :u, now()) RETURNING id`, { ...r, k: contrato }, tx);
    const file = await env.file(A(), tx);
    const [{ id: assinatura }] = await env.query(`INSERT INTO legal.addendum_signatures (id, group_id, company_id, addendum_id, person_id, party_role, evidence_file_id, collected_by_user_id, created_at)
      VALUES (gen_random_uuid(), :g, :c, :a, :p, 'TENANT', :f, :u, now()) RETURNING id`, { ...r, a: aditivo, f: file.id }, tx);
    const [{ id: vigente }] = await env.query(`INSERT INTO legal.guarantees (id, group_id, company_id, contract_id, guarantee_type, holder_person_id, created_at, updated_at)
      VALUES (gen_random_uuid(), :g, :c, :k, 'GUARANTOR', :p, now(), now()) RETURNING id`, { ...r, k: contrato }, tx);
    const [{ id: substituida }] = await env.query(`INSERT INTO legal.guarantees (id, group_id, company_id, contract_id, guarantee_type, holder_person_id, replaced_by_guarantee_id,
        additional_guarantor_person_ids, created_at, updated_at)
      VALUES (gen_random_uuid(), :g, :c, :k, 'GUARANTOR', :p, :v, to_jsonb(ARRAY[CAST(:p AS text)]), now(), now()) RETURNING id`, { ...r, k: contrato, v: vigente }, tx);
    // Marco 4: lançamento com titular de terceiro (append-only; o titular não muda depois de criado).
    const [{ id: lancamento }] = await env.query(`INSERT INTO finance.financial_entries (id, group_id, company_id, entry_type, nature, amount, status, idempotency_key, created_by,
        third_party_holder_person_id, created_at, updated_at)
      VALUES (gen_random_uuid(), :g, :c, 'CREDIT', 'RECEIVABLE', 100, 'PENDING', 'qa-m9d805-hist-' || gen_random_uuid(), :u, :p, now(), now()) RETURNING id`, r, tx);

    // A rota /impact conta só o que a união vai mover: a garantia vigente sim; a assinatura, a garantia substituída e o lançamento não.
    const impacto = await references.countReferences('PERSON', absorbed.id, tx);
    assert.equal(impacto['legal.guarantees.holder_person_id'], 1);
    for (const k of ['legal.addendum_signatures.person_id', 'finance.financial_entries.third_party_holder_person_id']) assert.equal(impacto[k], undefined, k);

    const done = await mergeService.decide(A(), actor, item.id, { decision: 'MERGED', survivorId: survivor.id, note: 'Mesma pessoa.' }, tx);
    assert.equal(done.status, 'MERGED');
    const um = async (sql, id) => (await env.query(sql, { id }, tx))[0];
    assert.equal((await um('SELECT person_id FROM legal.addendum_signatures WHERE id = :id', assinatura)).person_id, absorbed.id, 'a assinatura do aditivo não é reescrita');
    assert.equal((await um('SELECT holder_person_id FROM legal.guarantees WHERE id = :id', substituida)).holder_person_id, absorbed.id, 'a garantia substituída fica como era');
    assert.equal((await um('SELECT holder_person_id FROM legal.guarantees WHERE id = :id', vigente)).holder_person_id, survivor.id, 'a garantia vigente segue o sobrevivente');
    assert.equal((await um('SELECT merged_into_id FROM people.persons WHERE id = :id', absorbed.id)).merged_into_id, survivor.id, 'o absorvido continua existindo e aponta o sobrevivente');
    assert.deepEqual((await um('SELECT additional_guarantor_person_ids AS f FROM legal.guarantees WHERE id = :id', substituida)).f, [absorbed.id], 'a lista de fiadores da substituída fica como era');
    assert.equal((await um('SELECT third_party_holder_person_id AS t FROM finance.financial_entries WHERE id = :id', lancamento)).t, absorbed.id, 'o lançamento não é reescrito');
  });
});

test('união de imóveis com match do radar: o rastro fica no imóvel absorvido e a união não falha', { skip: skip() }, async () => {
  await env.withRollbackTenantTransaction(A(), async (tx) => {
    const p1 = await env.property(A(), tx);
    const p2 = await env.property(A(), tx);
    const item = await env.candidate(A(), tx, 'PROPERTY', p1.id, p2.id, { reason: 'PROPERTY_REGISTRY', score: 95 });
    const { actor } = await env.steward(A(), tx);
    const absorvido = item.primary_id === p1.id ? p2 : p1;
    const pessoa = await env.person(A(), tx, { legalName: 'Cliente do radar' });
    const r = { g: A().groupId, c: A().companyId, pes: pessoa.id, imv: absorvido.id };
    const [{ id: radar }] = await env.query(`INSERT INTO crm.property_radars (id, group_id, company_id, person_id, criteria_json, created_at, updated_at)
      VALUES (gen_random_uuid(), :g, :c, :pes, '{}'::jsonb, now(), now()) RETURNING id`, r, tx);
    const [{ id: match }] = await env.query(`INSERT INTO crm.radar_matches (id, group_id, company_id, radar_id, property_id, score, explanation, criteria_fingerprint, criteria_version, created_at)
      VALUES (gen_random_uuid(), :g, :c, :rad, :imv, 0.9, '{}'::jsonb, 'fp-qa', 1, now()) RETURNING id`, { ...r, rad: radar }, tx);
    assert.equal((await references.countReferences('PROPERTY', absorvido.id, tx))['crm.radar_matches.property_id'], undefined, '/impact não conta o rastro');
    const done = await mergeService.decide(A(), actor, item.id, { decision: 'MERGED', survivorId: item.primary_id }, tx);
    assert.equal(done.status, 'MERGED');
    assert.equal((await env.query('SELECT property_id FROM crm.radar_matches WHERE id = :id', { id: match }, tx))[0].property_id, absorvido.id);
  });
});
