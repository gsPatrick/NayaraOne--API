'use strict';

// M9-D802 — matriz de transição (§3.2.1), desempate e fontes de M9-D803 pelo projetor. Banco descartável (ver m9d802.projetor.test.js).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const env = require('../_helpers/m9d802Env');
const { applyTransition } = require('../../../src/features/core-governance/calendar/projector/projector.state');

require('../../../src/features/core-governance'); // carrega o módulo como em produção: registra o projetor no outbox
let tenants;
const skip = () => (env.DISPOSABLE ? false : env.SKIP_DISPOSABLE);
before(async () => { if (env.DISPOSABLE) tenants = await env.loadTenants(); });
after(async () => { await env.sequelize.close(); });
const run = (fn) => env.withRollbackTenantTransaction(tenants.A, fn);
const dl = (id, extra = {}) => ({ id, description: 'Prazo', dueAt: '2026-11-10', responsibleUserId: tenants.A.userId, status: 'PENDING', ...extra });
const T = (hour) => `2026-10-20T${hour}:00:00Z`;

test('m9d802 matriz: cada par evento x status da tabela 3.2.1', () => {
  const expected = {
    DONE: { OPEN: 'DONE', DONE: null, CANCELLED: null },
    CANCELLED: { OPEN: 'CANCELLED', DONE: null, CANCELLED: null },
    OPEN: { OPEN: null, DONE: 'OPEN', CANCELLED: 'OPEN' },
  };
  for (const [event, row] of Object.entries(expected)) {
    for (const [current, result] of Object.entries(row)) {
      const out = applyTransition({ status: current }, { status: event });
      assert.equal(out.effect === 'APPLIED' ? out.state.status : null, result, `${event} sobre ${current}`);
    }
  }
  assert.equal(applyTransition(null, { status: 'DONE' }).effect, 'NO_ITEM');
});

test('m9d802 UPSERT sobre item DONE não reabre e DONE sobre CANCELLED fecha', { skip: skip() }, async () => {
  await run(async (tx) => {
    const id = env.randomUUID();
    await env.projectEvent(env.ev(tenants.A, 'legal.deadline.created', dl(id), T('10')), tx);
    await env.projectEvent(env.ev(tenants.A, 'legal.deadline.completed', dl(id), T('11')), tx);
    await env.projectEvent(env.ev(tenants.A, 'legal.deadline.updated', dl(id, { description: 'Prazo renomeado' }), T('12')), tx);
    let item = await env.itemOf(tenants.A, 'LEGAL_DEADLINE', id, tx);
    assert.equal(item.status, 'DONE', 'UPSERT não reabre');
    assert.equal(item.title, 'Prazo renomeado', 'mas atualiza os campos');
    // CANCELLED não vai a DONE (sem efeito, IGNORED_TRANSITION); o caminho para fechar é reabrir e então concluir.
    const other = env.randomUUID();
    await env.projectEvent(env.ev(tenants.A, 'legal.deadline.created', dl(other), T('10')), tx);
    await env.projectEvent(env.ev(tenants.A, 'legal.deadline.cancelled', dl(other), T('11')), tx);
    const done = env.ev(tenants.A, 'legal.deadline.completed', dl(other), T('12'));
    await env.projectEvent(done, tx);
    item = await env.itemOf(tenants.A, 'LEGAL_DEADLINE', other, tx);
    assert.equal(item.status, 'CANCELLED', 'DONE não age sobre CANCELLED');
    assert.equal((await env.inboxStatus(done.id, tx)).status, 'IGNORED_TRANSITION');
    await env.projectEvent(env.ev(tenants.A, 'legal.deadline.reopened', dl(other), T('13')), tx);
    assert.equal((await env.itemOf(tenants.A, 'LEGAL_DEADLINE', other, tx)).status, 'OPEN');
    await env.projectEvent(env.ev(tenants.A, 'legal.deadline.completed', dl(other), T('14')), tx);
    assert.equal((await env.itemOf(tenants.A, 'LEGAL_DEADLINE', other, tx)).status, 'DONE', 'reaberto, então fecha');
    // Item inexistente: o evento de fechamento cria o item já no estado final.
    const fresh = env.randomUUID();
    await env.projectEvent(env.ev(tenants.A, 'legal.deadline.completed', dl(fresh), T('10')), tx);
    assert.equal((await env.itemOf(tenants.A, 'LEGAL_DEADLINE', fresh, tx)).status, 'DONE');
    const gone = env.randomUUID();
    await env.projectEvent(env.ev(tenants.A, 'legal.deadline.cancelled', dl(gone), T('10')), tx);
    const cancelled = await env.itemOf(tenants.A, 'LEGAL_DEADLINE', gone, tx);
    assert.equal(cancelled.status, 'CANCELLED');
    assert.equal(cancelled.cancel_reason, 'SOURCE_CANCELLED');
  });
});

test('m9d802 origem excluída de item DONE mantém DONE', { skip: skip() }, async () => {
  await run(async (tx) => {
    const id = env.randomUUID();
    await env.projectEvent(env.ev(tenants.A, 'legal.deadline.completed', dl(id), T('10')), tx);
    const del = env.ev(tenants.A, 'legal.deadline.cancelled', dl(id), T('11'));
    await env.projectEvent(del, tx);
    assert.equal((await env.itemOf(tenants.A, 'LEGAL_DEADLINE', id, tx)).status, 'DONE', 'histórico concluído não é cancelado');
    assert.equal((await env.inboxStatus(del.id, tx)).status, 'IGNORED_TRANSITION');
    const open = env.randomUUID();
    await env.projectEvent(env.ev(tenants.A, 'legal.deadline.created', dl(open), T('10')), tx);
    await env.projectEvent(env.ev(tenants.A, 'legal.deadline.cancelled', dl(open), T('11')), tx);
    assert.equal((await env.itemOf(tenants.A, 'LEGAL_DEADLINE', open, tx)).status, 'CANCELLED');
  });
});

test('m9d802 empate de occurredAt prefere DONE', { skip: skip() }, async () => {
  await run(async (tx) => {
    for (const order of [['reopen', 'done'], ['done', 'reopen']]) {
      const id = env.randomUUID();
      await env.projectEvent(env.ev(tenants.A, 'legal.deadline.completed', dl(id), T('09')), tx);
      const events = { done: 'legal.deadline.completed', reopen: 'legal.deadline.reopened' };
      for (const name of order) await env.projectEvent(env.ev(tenants.A, events[name], dl(id), T('10')), tx);
      // Reabertura e conclusão no MESMO instante: DONE prevalece sobre OPEN, qualquer que seja a ordem de chegada.
      assert.equal((await env.itemOf(tenants.A, 'LEGAL_DEADLINE', id, tx)).status, 'DONE', `ordem ${order.join('>')}`);
    }
  });
});

test('m9d802 eventos de CONSTRUCTION e GUARANTEE de M9-D803 atualizam o item', { skip: skip() }, async () => {
  await run(async (tx) => {
    const stageId = env.randomUUID();
    const stage = { projectId: env.randomUUID(), stageId, projectName: 'Obra Sol', stageName: 'Reboco', endsAt: '2026-11-12T20:00:00Z', status: 'IN_PROGRESS', responsibleUserId: tenants.A.userId };
    await env.projectEvent(env.ev(tenants.A, 'project.stage.updated', { ...stage, id: stageId }, T('10')), tx);
    let item = await env.itemOf(tenants.A, 'CONSTRUCTION', stageId, tx);
    assert.equal(item.status, 'OPEN');
    assert.match(item.deep_link, /^\/painel\/obras\//);
    await env.projectEvent(env.ev(tenants.A, 'project.stage.completed', { id: stageId, stageId, projectId: stage.projectId }, T('11')), tx);
    assert.equal((await env.itemOf(tenants.A, 'CONSTRUCTION', stageId, tx)).status, 'DONE', 'etapa concluída fecha');
    // Caso em garantia: escalonamento só sobe a severidade e não reabre item fechado.
    const caseId = env.randomUUID();
    const warranty = { id: caseId, description: 'Infiltração', warrantyDeadlineAt: '2026-12-01T15:00:00Z', responsibleUserId: tenants.A.userId };
    await env.projectEvent(env.ev(tenants.A, 'warranty.case.opened', warranty, T('10')), tx);
    await env.projectEvent(env.ev(tenants.A, 'warranty.case.escalated', warranty, T('11')), tx);
    item = await env.itemOf(tenants.A, 'GUARANTEE', caseId, tx);
    assert.deepEqual([item.status, item.severity], ['OPEN', 'CRITICAL']);
    await env.projectEvent(env.ev(tenants.A, 'warranty.case.closed', warranty, T('12')), tx);
    await env.projectEvent(env.ev(tenants.A, 'warranty.case.escalated', warranty, T('13')), tx);
    item = await env.itemOf(tenants.A, 'GUARANTEE', caseId, tx);
    assert.equal(item.status, 'DONE', 'escalonamento não reabre o caso fechado');
    const gId = env.randomUUID();
    await env.projectEvent(env.ev(tenants.A, 'legal.guarantee.created', { id: gId, contractId: env.randomUUID(), guaranteeType: 'CAUCAO', endsAt: '2027-01-15', status: 'ACTIVE', contractNumber: 'LOC-1' }, T('10')), tx);
    assert.equal((await env.itemOf(tenants.A, 'GUARANTEE', gId, tx)).source_kind, 'LEGAL_GUARANTEE');
    const wId = env.randomUUID();
    await env.projectEvent(env.ev(tenants.A, 'project.warranty_started', { id: wId, name: 'Obra Sol', warrantyEndsAt: '2031-10-20', responsibleUserId: tenants.A.userId }, T('10')), tx);
    const rows = await env.sequelize.query("SELECT source_kind FROM governance.calendar_items WHERE company_id = :c AND source_kind = 'PROJECT_WARRANTY'", { replacements: { c: tenants.A.companyId }, transaction: tx, type: 'SELECT' });
    assert.ok(rows.length >= 1, 'garantia da obra entregue vira item');
    // O que a API devolve em GET /calendar?sourceType=CONSTRUCTION|GUARANTEE (mesmo serviço da rota), com deep_link válido.
    const { listCalendar } = require('../../../src/features/core-governance/calendar/calendar.service');
    const permissions = ['governance:calendar:read', 'construction:read', 'legal:read'];
    const query = { from: '2026-10-01', to: '2031-12-31', sourceType: 'CONSTRUCTION,GUARANTEE', pageSize: '200' };
    const api = await listCalendar(tenants.A, { permissions, query, now: new Date('2026-10-20T12:00:00Z') }, tx);
    const byId = new Map(api.items.map((row) => [row.sourceId, row]));
    const { projectWarrantySourceId } = require('../../../src/features/core-governance/calendar/sources/ids');
    for (const [type, id] of [['CONSTRUCTION', stageId], ['GUARANTEE', caseId], ['GUARANTEE', gId], ['GUARANTEE', projectWarrantySourceId(wId)]]) {
      assert.equal((byId.get(id) || {}).sourceType, type, `GET /calendar mostra ${type} ${id}`);
    }
    assert.ok(api.items.every((row) => /^\/painel\//.test(row.deepLink)), 'deep_link válido em todos');
  });
});

test('m9d802 o consumidor registrado no outbox entrega o evento ao projetor', { skip: skip() }, async () => {
  await run(async (tx) => {
    const { publishDomainEvent } = require('../../../src/engines/events/outbox');
    const id = env.randomUUID();
    await publishDomainEvent({
      groupId: tenants.A.groupId, companyId: tenants.A.companyId, aggregateType: 'LegalDeadline', aggregateId: id, eventType: 'legal.deadline.created',
      payload: dl(id), idempotencyKey: `legal.deadline.created:${id}`,
    }, tx);
    await env.drain(tenants.A, tx);
    assert.equal((await env.itemOf(tenants.A, 'LEGAL_DEADLINE', id, tx)).status, 'OPEN');
  });
});
