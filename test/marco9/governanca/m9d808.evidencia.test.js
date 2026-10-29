'use strict';

// M9-D808 — alteração em massa: campo crítico passa pelo guard de evidência da M9-D807, falha no meio desfaz o lote, troca de curador na fila e /impact.
// Banco descartável (ver m9d808.servico.test.js).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const env = require('../_helpers/m9d808Env');
const bulk = require('../../../src/features/core-governance/data-quality/bulk.service');
const { withTenantTransaction } = require('../../testHelpers');
const { adminQuery } = require('../../m9d801.helpers');

let tenants;
const skip = () => (env.DISPOSABLE ? false : env.SKIP_DISPOSABLE);
before(async () => { if (env.DISPOSABLE) tenants = await env.loadTenants(); });
after(async () => { await env.sequelize.close(); });
const A = () => tenants.A;
const execute = (tx, body, key = env.key()) => bulk.executeBulk(A(), { userId: A().userId, roles: [] }, body, { idempotencyKey: key }, tx);
const codeOf = (promise) => promise.then(() => null, (err) => [err.statusCode, err.code]);
const OTHER = (note = 'Conferido com a certidão do cartório em 29/10') => ({ source: 'OTHER', note });

test('m9d808 campo crítico sem evidência é recusado (422 GOV_EVIDENCE_REQUIRED) e nada é gravado', { skip: skip() }, async () => {
  const { city, rows } = await withTenantTransaction(A(), (tx) => env.properties(A(), tx, 3, { registryNumber: null }));
  const body = env.bulkBody(city, { registryNumber: `MAT-${env.tag()}`, city: 'Mudou Junto' });
  const failure = await codeOf(withTenantTransaction(A(), (tx) => execute(tx, body)));
  assert.deepEqual(failure, [422, 'GOV_EVIDENCE_REQUIRED']);
  for (const row of rows) assert.equal(await env.cityOf(row.id), city, 'nem o campo comum foi gravado');
  const stored = (await adminQuery('SELECT count(*)::int AS n FROM governance.bulk_changes WHERE company_id = $1 AND filter_json->>\'city\' = $2', [A().companyId, city])).rows[0].n;
  assert.equal(stored, 0, 'nenhum lote criado');
  const blocked = (await adminQuery("SELECT after_json FROM audit.audit_log WHERE company_id = $1 AND action = 'governance.bulk_change.blocked' AND after_json->>'code' = 'GOV_EVIDENCE_REQUIRED' AND after_json->>'filterHash' IS NOT NULL ORDER BY occurred_at DESC LIMIT 1", [A().companyId])).rows;
  assert.equal(blocked.length, 1, 'a recusa também é auditada');
});

test('m9d808 uma evidência única vale para o lote: conta bancária de fornecedores com origem registrada por registro', { skip: skip() }, async () => {
  const tag = env.tag();
  const suppliers = await withTenantTransaction(A(), async (tx) => {
    const list = [];
    for (let i = 0; i < 3; i += 1) {
      const supplier = await env.supplier(A(), tx, { legalName: `Fornecedora Lote ${tag} ${'ABC'[i]}`, taxIdNormalized: env.cnpj() });
      await env.bankAccount(A(), tx, supplier.id, { status: 'ACTIVE', pixKey: `antiga-${i}@qa-m9.test` });
      list.push(supplier);
    }
    return list;
  });
  const body = { entity_type: 'SUPPLIER', filter: { ids: suppliers.map((s) => s.id) }, patch: { pixKey: 'nova-chave@qa-m9.test' }, reason: 'QA-M9 troca de chave PIX dos fornecedores' };
  assert.deepEqual(await codeOf(withTenantTransaction(A(), (tx) => execute(tx, body))), [422, 'GOV_EVIDENCE_REQUIRED']);
  const lot = await withTenantTransaction(A(), (tx) => execute(tx, { ...body, change_evidence: OTHER() }));
  assert.equal(lot.lot.affectedCount, 3, 'uma conta por fornecedor');
  const accounts = (await adminQuery('SELECT pix_key FROM finance.bank_accounts WHERE owner_person_id = ANY($1)', [suppliers.map((s) => s.id)])).rows;
  assert.deepEqual(accounts.map((a) => a.pix_key), ['nova-chave@qa-m9.test', 'nova-chave@qa-m9.test', 'nova-chave@qa-m9.test']);
  const evidence = (await adminQuery("SELECT field, source, value_after_hash FROM governance.field_change_evidence WHERE company_id = $1 AND entity_type = 'BANK_ACCOUNT' AND note LIKE 'Conferido com a certidão%' AND field = 'pixKey'", [A().companyId])).rows;
  assert.equal(evidence.length, 3);
  assert.ok(evidence.every((e) => e.source === 'OTHER' && /^[0-9a-f]{64}$/.test(e.value_after_hash)));
  const items = (await adminQuery('SELECT record_type FROM governance.bulk_change_items WHERE bulk_change_id = $1', [lot.lot.id])).rows;
  assert.deepEqual(items.map((i) => i.record_type), ['BANK_ACCOUNT', 'BANK_ACCOUNT', 'BANK_ACCOUNT']);
  const noteShort = await codeOf(withTenantTransaction(A(), (tx) => execute(tx, { ...body, patch: { pixKey: 'outra@qa-m9.test' }, change_evidence: OTHER('curta') })));
  assert.deepEqual(noteShort, [422, 'GOV_EVIDENCE_NOTE_TOO_SHORT']);
});

test('m9d808 falha em um registro desfaz o lote inteiro e o lote fica FAILED', { skip: skip() }, async () => {
  const { city, rows } = await withTenantTransaction(A(), (tx) => env.properties(A(), tx, 3, { registryNumber: null }));
  const sameRegistry = `MAT-DUP-${env.tag()}`;
  const key = env.key();
  const body = env.bulkBody(city, { registryNumber: sameRegistry, city: 'Nao Pode Ficar' }, { change_evidence: OTHER() });
  const failure = await codeOf(withTenantTransaction(A(), (tx) => execute(tx, body, key)));
  assert.deepEqual(failure, [500, 'INTERNAL_ERROR'], 'a matrícula repetida viola a unicidade do cadastro');
  for (const row of rows) assert.equal(await env.cityOf(row.id), city, 'nenhum imóvel mudou');
  const lots = (await adminQuery('SELECT status, affected_count, error_message FROM governance.bulk_changes WHERE company_id = $1 AND idempotency_key = $2', [A().companyId, key])).rows;
  assert.deepEqual(lots.map((l) => [l.status, l.affected_count]), [['FAILED', 0]]);
  assert.ok(lots[0].error_message);
  const items = (await adminQuery('SELECT count(*)::int AS n FROM governance.bulk_change_items i JOIN governance.bulk_changes b ON b.id = i.bulk_change_id WHERE b.idempotency_key = $1', [key])).rows[0].n;
  assert.equal(items, 0);
  const itemAudits = (await adminQuery("SELECT count(*)::int AS n FROM audit.audit_log WHERE company_id = $1 AND action = 'governance.bulk_change.item' AND entity_id = ANY($2)", [A().companyId, rows.map((r) => r.id)])).rows[0].n;
  assert.equal(itemAudits, 0, 'nenhuma auditoria de item sobrou');
  const retry = await withTenantTransaction(A(), (tx) => execute(tx, env.bulkBody(city, { city: 'Agora Vai' }), key));
  assert.equal(retry.lot.status, 'DONE', 'a mesma chave pode ser repetida depois de um lote FAILED');
});

test('m9d808 troca de curador em massa muda o assigned_steward_id dos itens de revisão', { skip: skip() }, async () => {
  const { people, items, user } = await withTenantTransaction(A(), async (tx) => {
    const created = [await env.person(A(), tx), await env.person(A(), tx), await env.person(A(), tx)];
    const queue = [];
    queue.push(await env.candidate(A(), tx, 'PERSON', created[0].id, created[1].id));
    queue.push(await env.candidate(A(), tx, 'PERSON', created[1].id, created[2].id));
    return { people: created, items: queue, user: await env.newUser(A(), tx) };
  });
  const body = { entity_type: 'PERSON', filter: { ids: people.map((p) => p.id) }, patch: { assignedStewardId: user.id }, reason: 'QA-M9 troca do curador da fila de revisão' };
  const result = await withTenantTransaction(A(), (tx) => execute(tx, body));
  assert.equal(result.lot.affectedCount, 2);
  const rows = (await adminQuery('SELECT id, assigned_steward_id FROM governance.review_queue_items WHERE id = ANY($1)', [items.map((i) => i.id)])).rows;
  assert.ok(rows.every((r) => r.assigned_steward_id === user.id));
  const lotItems = (await adminQuery('SELECT record_type FROM governance.bulk_change_items WHERE bulk_change_id = $1', [result.lot.id])).rows;
  assert.deepEqual(lotItems.map((i) => i.record_type), ['REVIEW_ITEM', 'REVIEW_ITEM']);
  const stranger = await env.randomUUID();
  assert.deepEqual(await codeOf(withTenantTransaction(A(), (tx) => execute(tx, { ...body, patch: { assignedStewardId: stranger } }))), [422, 'GOV_ASSIGNEE_INACTIVE']);
});

test('m9d808 /impact conta o que mudaria e lista os impedimentos sem gravar nada', { skip: skip() }, async () => {
  await env.withRollbackTenantTransaction(A(), async (tx) => {
    const { city, rows } = await env.properties(A(), tx, 4);
    const ok = await bulk.impactOf(A(), env.bulkBody(city, { city: 'Simulado' }), tx);
    assert.deepEqual(ok.counts, { records: 4, willChange: 4, byRecordType: { PROPERTY: 4 } });
    assert.deepEqual([ok.totalAmountCents, ok.blockers], [0, []]);
    const critical = await bulk.impactOf(A(), env.bulkBody(city, { registryNumber: 'MAT-IMPACTO-1' }), tx);
    assert.deepEqual(critical.blockers.map((b) => b.code), ['GOV_EVIDENCE_REQUIRED']);
    assert.equal(await env.cityOf(rows[0].id, tx), city);
    assert.deepEqual(await env.lotRows(A(), tx, "filter_json->>'city' = :city", { city }), []);
  });
});
