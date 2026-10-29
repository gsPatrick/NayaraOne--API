'use strict';

// M9-D802 — projetor do Calendário: idempotência, ordem, matriz de transição e saída. Banco descartável:
//   node scripts/withDisposableDb.js --port <55000-56999> -- env CI_TENANT_USERS_PASSWORD=... bash -c \
//     "node scripts/seed-ci-two-tenants.js >/dev/null && NODE_ENV=test node --test --test-concurrency=1 test/marco9/governanca/m9d802.projetor.test.js"

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const env = require('../_helpers/m9d802Env');

let tenants;
const skip = () => (env.DISPOSABLE ? false : env.SKIP_DISPOSABLE);
before(async () => { if (env.DISPOSABLE) tenants = await env.loadTenants(); });
after(async () => { await env.sequelize.close(); });

const run = (fn) => env.withRollbackTenantTransaction(tenants.A, fn);
const deadline = (id, extra = {}) => ({ id, description: 'Contestação', dueAt: '2026-11-10', responsibleUserId: tenants.A.userId, status: 'PENDING', ...extra });

test('m9d802 calendar replay não duplica', { skip: skip() }, async () => {
  await run(async (tx) => {
    const id = env.randomUUID();
    const event = env.ev(tenants.A, 'legal.deadline.created', deadline(id));
    const first = await env.projectEvent(event, tx);
    const second = await env.projectEvent(event, tx);
    const third = await env.projectEvent(event, tx);
    assert.equal(first.duplicate, false);
    assert.equal(second.duplicate, true);
    assert.equal(third.duplicate, true);
    assert.equal(await env.countItems(tenants.A, 'LEGAL_DEADLINE', id, tx), 1, 'uma linha só');
    const item = await env.itemOf(tenants.A, 'LEGAL_DEADLINE', id, tx);
    assert.equal(item.projection_version, 1, 'a versão não sobe no replay');
    assert.equal((await env.updatedEvents(item.id, tx)).length, 1, 'um evento de saída');
    // Outro event_id com o mesmo conteúdo (reentrega com novo id): o UPSERT por origem também não duplica nem muda nada.
    await env.projectEvent(env.ev(tenants.A, 'legal.deadline.updated', deadline(id), '2026-10-20T12:05:00Z'), tx);
    assert.equal(await env.countItems(tenants.A, 'LEGAL_DEADLINE', id, tx), 1);
    assert.equal((await env.itemOf(tenants.A, 'LEGAL_DEADLINE', id, tx)).projection_version, 1, 'sem mudança efetiva a versão não sobe');
    assert.equal((await env.updatedEvents(item.id, tx)).length, 1);
  });
});

test('m9d802 source concluído fecha item', { skip: skip() }, async () => {
  await run(async (tx) => {
    const id = env.randomUUID();
    await env.projectEvent(env.ev(tenants.A, 'legal.deadline.created', deadline(id)), tx);
    assert.equal((await env.itemOf(tenants.A, 'LEGAL_DEADLINE', id, tx)).status, 'OPEN');
    await env.projectEvent(env.ev(tenants.A, 'legal.deadline.completed', deadline(id, { status: 'DONE' }), '2026-10-20T14:00:00Z'), tx);
    const item = await env.itemOf(tenants.A, 'LEGAL_DEADLINE', id, tx);
    assert.equal(item.status, 'DONE');
    assert.equal(item.due_at.toISOString(), '2026-11-11T02:59:59.000Z', 'prazo às 23:59:59 de Brasília');
    assert.equal(item.deep_link, `/painel/juridico/prazos/${id}`);
  });
});

test('m9d802 evento fora de ordem é ignorado', { skip: skip() }, async () => {
  await run(async (tx) => {
    const id = env.randomUUID();
    await env.projectEvent(env.ev(tenants.A, 'legal.deadline.completed', deadline(id, { status: 'DONE' }), '2026-10-20T14:00:00Z'), tx);
    const late = env.ev(tenants.A, 'legal.deadline.updated', deadline(id, { description: 'Atrasado', dueAt: '2026-12-01' }), '2026-10-20T13:55:00Z');
    await env.projectEvent(late, tx);
    const item = await env.itemOf(tenants.A, 'LEGAL_DEADLINE', id, tx);
    assert.equal(item.status, 'DONE', 'permanece DONE');
    assert.equal(item.title, 'Contestação', 'campos do evento atrasado não são aplicados');
    assert.equal((await env.inboxStatus(late.id, tx)).status, 'IGNORED_STALE');
  });
});

test('m9d802 evento publica uma única vez calendar.item.updated', { skip: skip() }, async () => {
  await run(async (tx) => {
    const id = env.randomUUID();
    await env.projectEvent(env.ev(tenants.A, 'legal.deadline.created', deadline(id)), tx);
    const item = await env.itemOf(tenants.A, 'LEGAL_DEADLINE', id, tx);
    await env.projectEvent(env.ev(tenants.A, 'legal.deadline.updated', deadline(id, { dueAt: '2026-11-20' }), '2026-10-21T10:00:00Z'), tx);
    const rows = await env.updatedEvents(item.id, tx);
    assert.equal(rows.length, 2, 'criação e mudança de due_at');
    const change = rows[1].payloadJson;
    assert.equal(change.itemId, item.id);
    assert.equal(change.sourceType, 'LEGAL_DEADLINE');
    assert.equal(change.sourceId, id);
    assert.deepEqual(change.changes.dueAt, { antes: '2026-11-11T02:59:59.000Z', apos: '2026-11-21T02:59:59.000Z' });
    assert.equal(rows[1].idempotencyKey, `calendar.item.updated:${item.id}:2`);
    assert.equal(rows[0].idempotencyKey, `calendar.item.updated:${item.id}:1`);
  });
});

test('m9d802 evento de empresa divergente é descartado', { skip: skip() }, async () => {
  await run(async (tx) => {
    const id = env.randomUUID();
    const foreign = env.ev(tenants.B, 'legal.deadline.created', deadline(id));
    const result = await env.projectEvent(foreign, tx);
    assert.equal(result.discarded, true);
    assert.equal(result.code, 'GOV_CALENDAR_TENANT_MISMATCH');
    assert.equal(await env.countItems(tenants.A, 'LEGAL_DEADLINE', id, tx), 0);
    const [audit] = await env.sequelize.query("SELECT after_json FROM audit.audit_log WHERE action = 'governance.calendar_event.discarded' AND entity_id = :id", { replacements: { id: foreign.id }, transaction: tx, type: 'SELECT' });
    assert.equal(audit.after_json.code, 'GOV_CALENDAR_TENANT_MISMATCH', 'descartado e auditado');
    // company_id do payload diferente do evento também descarta.
    const forged = env.ev(tenants.A, 'legal.deadline.created', { ...deadline(id), companyId: tenants.B.companyId });
    assert.equal((await env.projectEvent(forged, tx)).discarded, true);
  });
});

test('m9d802 evento sem mapeamento vai para dead-letter com motivo', { skip: skip() }, async () => {
  await run(async (tx) => {
    const event = env.ev(tenants.A, 'legal.nao_existe', {});
    await env.projectEvent(event, tx);
    const inbox = await env.inboxStatus(event.id, tx);
    assert.equal(inbox.status, 'DEAD');
    assert.match(inbox.dead_letter_reason, /GOV_CALENDAR_EVENT_UNKNOWN/);
  });
});

test('m9d802 falha no meio desfaz item e evento', { skip: skip() }, async () => {
  const id = env.randomUUID();
  const event = env.ev(tenants.A, 'legal.deadline.created', deadline(id));
  const outbox = require('../../../src/engines/events/outbox');
  const original = outbox.publishDomainEvent;
  const store = require('../../../src/features/core-governance/calendar/projector/projector.apply');
  assert.ok(store.applyMapped, 'o projetor usa applyMapped');
  // A gravação do evento de saída falha DEPOIS do item gravado: tudo volta (savepoint) e o evento de entrada permanece pendente.
  const { OutboxEvent } = require('../../../src/models');
  const hook = (instance) => { if (instance.eventType === 'calendar.item.updated') throw new Error('falha simulada'); };
  OutboxEvent.addHook('beforeCreate', 'm9d802-falha', hook);
  try {
    await run(async (tx) => {
      await assert.rejects(() => env.sequelize.transaction({ transaction: tx }, (sp) => env.projectEvent(event, sp)), /falha simulada/);
      assert.equal(await env.countItems(tenants.A, 'LEGAL_DEADLINE', id, tx), 0, 'item desfeito');
      assert.equal(await env.inboxStatus(event.id, tx), null, 'sem registro de inbox: reentrega possível');
    });
  } finally {
    OutboxEvent.removeHook('beforeCreate', 'm9d802-falha');
    assert.equal(outbox.publishDomainEvent, original);
  }
});

test('m9d802 a varredura diária de M9-D803 também publica calendar.item.updated ao fechar', { skip: skip() }, async () => {
  const { runBackfill } = require('../../../src/features/core-governance/calendar/sources/backfill.service');
  await run(async (tx) => {
    const projectId = env.randomUUID();
    await env.projectEvent(env.ev(tenants.A, 'project.warranty_started', { id: projectId, name: 'Obra Lua', warrantyEndsAt: '2026-11-30', responsibleUserId: tenants.A.userId }), tx);
    const { projectWarrantySourceId } = require('../../../src/features/core-governance/calendar/sources/ids');
    const sourceId = projectWarrantySourceId(projectId);
    const item = await env.itemOf(tenants.A, 'GUARANTEE', sourceId, tx);
    assert.equal(item.status, 'OPEN');
    await runBackfill(tenants.A, tx, new Date('2026-12-15T12:00:00Z'));
    assert.equal((await env.itemOf(tenants.A, 'GUARANTEE', sourceId, tx)).status, 'DONE');
    const events = await env.updatedEvents(item.id, tx);
    assert.equal(events.length, 2);
    assert.deepEqual(events[1].payloadJson.changes.status, { antes: 'OPEN', apos: 'DONE' });
  });
});
