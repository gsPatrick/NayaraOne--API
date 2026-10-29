'use strict';

// M9-D832 — regras da importação (serviço, banco descartável): idempotência, serviço normal e suas travas, divergência, lote, atomicidade, destino único do erro, conferência antes do evento e setor.
const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const env = require('../_helpers/m9d832Env');
const { createReceivable, createBareContract } = require('../_helpers/m9d832More');

const skip = () => (env.DISPOSABLE ? false : env.SKIP_DISPOSABLE);
let A;
let ctx;
const importedEvents = (op) => env.outbox(`bcp.manual_operation.imported:${A.companyId}:${op.manualReference}`);
const count = async (sql, params) => (await env.adminQuery(sql, params)).rows[0].n;

before(async () => {
  if (!env.DISPOSABLE) return;
  ({ A } = await env.loadTenants());
  await env.prepare(A);
  ctx = await env.context(A);
});
afterEach(async () => { if (env.DISPOSABLE) await env.prepare(A); });
after(async () => { if (env.DISPOSABLE) { await env.cleanImports(); await env.sequelize.close(); } });

test('m9d832 BCP record importado 2x não duplica e a segunda resposta é igual à primeira', { skip: skip() }, async () => {
  const phone = require('../_helpers/m9d832Payloads').phone();
  const op = await env.recordAction(A, 'REGISTER_LEAD', ctx, { telefone: phone });
  const first = (await env.importIds(A, [op.id])).items[0];
  const second = (await env.importIds(A, [op.id])).items[0];
  assert.deepEqual({ ...second, alreadyImported: false }, first, 'mesma resposta, só marcada como repetida');
  assert.equal(first.alreadyImported, false);
  assert.equal(second.alreadyImported, true);
  assert.equal(await count('SELECT count(*)::int AS n FROM crm.opportunities o JOIN people.person_contacts c ON c.person_id = o.person_id WHERE c.value_normalized = $1', [phone]), 1, 'um lançamento só');
  assert.equal(await count('SELECT count(*)::int AS n FROM governance.manual_operation_imports WHERE manual_operation_id = $1', [op.id]), 1);
  assert.equal((await importedEvents(op)).length, 1, 'um evento só (idempotência do evento imported)');
  assert.deepEqual((await importedEvents(op))[0].payload_json, { manualReference: op.manualReference, sector: 'ATENDIMENTO', commandRef: first.commandRef, result: 'MATCHED' });
  assert.equal((await env.opRow(op.id)).status, 'RECONCILED');
});

test('m9d832 import usa o serviço normal e respeita as validações dele', { skip: skip() }, async () => {
  const settled = await createReceivable(A, ctx.base, 700);
  const first = await env.recordAction(A, 'RECEIVE_PAYMENT', { ...ctx, receivableId: settled }, { valorCentavos: 70000 });
  assert.equal((await env.importIds(A, [first.id])).items[0].status, 'RECONCILED');
  const again = await env.recordAction(A, 'RECEIVE_PAYMENT', { ...ctx, receivableId: settled }, { valorCentavos: 70000 });
  const noCenter = await env.recordAction(A, 'EMERGENCY_PAYMENT', ctx, { centroCusto: '00000000-0000-4000-8000-000000000000' });
  const day = require('../_helpers/m9d832Payloads').PAYLOADS.DAILY_REPORT(ctx).data;
  const d1 = await env.recordAction(A, 'DAILY_REPORT', ctx, { data: day });
  const d2 = await env.recordAction(A, 'DAILY_REPORT', ctx, { data: day });
  const { items } = await env.importIds(A, [again.id, noCenter.id, d1.id, d2.id]);
  assert.deepEqual(items.map((i) => i.error && i.error.code), ['GOV_BCP_COMMAND_REJECTED', 'GOV_BCP_COMMAND_REJECTED', null, 'GOV_BCP_COMMAND_REJECTED']);
  assert.match(items[0].error.message, /Só é possível liquidar um lançamento PENDING/, 'a recusa é a do serviço do Financeiro');
  assert.match(items[3].error.message, /Já existe um RDO para esta obra nesta data e turno/, 'a recusa é a do serviço de Obras');
  assert.equal(await count("SELECT count(*)::int AS n FROM finance.financial_entries WHERE origin_ref = $1", [`bcp:${noCenter.manualReference}`]), 0);
  for (const op of [again, noCenter, d2]) assert.equal((await env.opRow(op.id)).status, 'RECORDED');
});

test('m9d832 valor divergente vira DIVERGENT com diff e a operação espera a decisão', { skip: skip() }, async () => {
  const receivableId = await createReceivable(A, ctx.base, 1205);
  const op = await env.recordAction(A, 'RECEIVE_PAYMENT', { ...ctx, receivableId }, { valorCentavos: 125000 });
  const item = (await env.importIds(A, [op.id])).items[0];
  assert.deepEqual([item.status, item.reconciliation.result], ['IMPORTED', 'DIVERGENT']);
  assert.deepEqual(item.reconciliation.diff, [{ field: 'valorCentavos', label: 'Valor (centavos)', paper: 125000, command: 120500, differenceCents: 4500 }]);
  const stored = await env.reconciliationOf(op.id);
  assert.deepEqual([stored.result, stored.decision, stored.reconciled_by, stored.reconciled_at], ['DIVERGENT', null, null, null]);
  assert.equal((await importedEvents(op))[0].payload_json.result, 'DIVERGENT');
});

test('m9d832 lote de 40 com 2 inválidas importa 38 e as 2 permanecem RECORDED com o motivo', { skip: skip() }, async () => {
  const ids = [];
  for (let i = 0; i < 38; i += 1) ids.push((await env.recordAction(A, 'REGISTER_LEAD', ctx, { nome: `Lote QA ${i}`, telefone: require('../_helpers/m9d832Payloads').phone() })).id);
  const bad = [];
  for (let i = 0; i < 2; i += 1) bad.push((await env.recordAction(A, 'REGISTER_LEAD', ctx, { telefone: 'curto' })).id);
  const { items, summary } = await env.importIds(A, [...ids, ...bad]);
  assert.deepEqual([summary.total, summary.reconciled, summary.failed], [40, 38, 2]);
  assert.equal(items.filter((i) => i.status === 'RECONCILED').length, 38);
  for (const item of items.filter((i) => i.error)) assert.equal(item.error.code, 'GOV_BCP_PAYLOAD_INVALID');
  for (const id of bad) {
    const row = await env.opRow(id);
    assert.equal(row.status, 'RECORDED');
    assert.match(row.last_error, /^GOV_BCP_PAYLOAD_INVALID: /);
    assert.ok(row.last_error_at, 'last_error_at gravado (destino único)');
  }
});

test('m9d832 falha no comando mantém RECORDED, sem lançamento, sem importação e sem evento', { skip: skip() }, async () => {
  const bare = await createBareContract(A, ctx.base);
  const before = await count('SELECT count(*)::int AS n FROM legal.key_deliveries WHERE contract_id = $1', [bare]);
  const op = await env.recordAction(A, 'REGISTER_KEY_DELIVERY', ctx, { contrato: bare });
  const item = (await env.importIds(A, [op.id])).items[0];
  assert.equal(item.error.code, 'GOV_BCP_COMMAND_REJECTED');
  assert.match(item.error.message, /vistoria de entrada/);
  assert.equal(await count('SELECT count(*)::int AS n FROM legal.key_deliveries WHERE contract_id = $1', [bare]), before, 'a entrega criada antes da recusa foi desfeita (tudo ou nada)');
  assert.equal((await env.opRow(op.id)).status, 'RECORDED');
  assert.match((await env.opRow(op.id)).last_error, /GOV_BCP_COMMAND_REJECTED/);
  assert.equal(await env.importRow(op.id), null);
  assert.equal((await importedEvents(op)).length, 0);
});

test('m9d832 payload inválido deixa a operação RECORDED com last_error e não executa nada', { skip: skip() }, async () => {
  const op = await env.recordAction(A, 'RECEIVE_PAYMENT', ctx, { valorCentavos: '1250.00' });
  const item = (await env.importIds(A, [op.id])).items[0];
  assert.equal(item.error.code, 'GOV_BCP_PAYLOAD_INVALID');
  assert.equal(item.error.message, 'Os dados do formulário não passam nas regras do sistema.');
  const row = await env.opRow(op.id);
  assert.deepEqual([row.status, row.import_command_ref], ['RECORDED', null]);
  assert.ok(row.last_error && row.last_error_at);
  assert.equal(await env.importRow(op.id), null);
});

test('m9d832 MATCHED leva a RECONCILED na mesma transação, com a conferência feita antes do evento', { skip: skip() }, async () => {
  const op = await env.recordAction(A, 'REGISTER_DEADLINE', ctx);
  const item = (await env.importIds(A, [op.id])).items[0];
  const rec = await env.reconciliationOf(op.id);
  const [event] = await importedEvents(op);
  assert.deepEqual([item.status, rec.result, (await env.opRow(op.id)).status], ['RECONCILED', 'MATCHED', 'RECONCILED']);
  assert.equal(event.payload_json.result, rec.result, 'o evento carrega o resultado da conferência, que já existia');
  assert.ok(rec.reconciled_by && rec.reconciled_at, 'MATCHED nasce concluída');
  assert.equal(rec.command_ref, item.commandRef);
  assert.equal(await count("SELECT count(*)::int AS n FROM audit.audit_log WHERE company_id = $1 AND action = 'bcp.manual_operation.imported' AND entity_id = $2", [A.companyId, op.id]), 1, 'auditoria ligada à operação');
});

test('m9d832 usuário de outro setor recebe 403 GOV_BCP_SECTOR_FORBIDDEN e nada é executado', { skip: skip() }, async () => {
  const maker = await env.otherUserId();
  await env.setSectorRoles(A, { FINANCEIRO: ['CI GESTOR'], OBRAS: ['CI GESTOR', 'CI MAKER'], ATENDIMENTO: ['CI GESTOR'] });
  const fin = await env.recordAction(A, 'EMERGENCY_PAYMENT', ctx, {}, { actorUserId: A.userId });
  const obra = await env.recordAction(A, 'MATERIAL_REQUEST', ctx);
  const err = await env.failure(env.importIds(A, [fin.id, obra.id], maker));
  assert.deepEqual([err.status, err.code, err.message], [403, 'GOV_BCP_SECTOR_FORBIDDEN', 'Você não pode importar operações deste setor.']);
  assert.equal(await env.importRow(obra.id), null, 'nenhuma operação do pedido foi executada');
  assert.equal((await env.importIds(A, [obra.id], maker)).items[0].error, null, 'o setor do usuário continua importável');
  assert.equal((await env.opRow(fin.id)).status, 'RECORDED');
});
