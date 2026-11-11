'use strict';

/**
 * Fechamento do Marco 5 — Jurídico, segunda onda: prazos pelo livro (Caderno M5 §15 "due_at em timezone correto +
 * responsável + severidade"; Guia do Marcelo §12 createDeadline com sourceFileId/sourceEventId, DEADLINE_SOURCE_REQUIRED
 * e a tarefa do responsável). Postgres real com RLS, transação desfeita no fim.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize, getSeedTenant, withRollbackTenantTransaction } = require('./testHelpers');
const { newUser, newCase, newDeadline, fakeFile, FUTURE } = require('./m5fech.juridico.helpers');
const legalDeadlinesService = require('../src/modules/legal/cases/deadline.service');
const legalCasesService = require('../src/modules/legal/cases/legal-case.service');
const { parseDueAt } = require('../src/modules/legal/cases/legalDeadlineDates');
const { LegalDeadline, Task, OutboxEvent, AuditLog, File } = require('../src/models');

let tenant;
before(async () => { tenant = await getSeedTenant(); });
after(async () => { await sequelize.close(); });

const codeIs = (code) => (err) => { assert.equal(err.code, code); return true; };
const update = (id, body, t, permissions) => legalDeadlinesService.updateLegalDeadline(id, body, tenant.userId, t, permissions ? { actorPermissions: permissions } : {});
const taskOf = (d, t) => Task.findByPk(d.taskId, { transaction: t });

test('JR prazo livro: due_at no fuso de São Paulo — só a data vence às 23:59 de Brasília, hora sem fuso é hora de Brasília, ISO com fuso é respeitado e data inexistente é 400', async () => {
  assert.equal(parseDueAt('2026-11-03').toISOString(), '2026-11-04T02:59:00.000Z');
  assert.equal(parseDueAt('2026-11-03T17:00').toISOString(), '2026-11-03T20:00:00.000Z');
  assert.equal(parseDueAt('2026-11-03T17:00:00Z').toISOString(), '2026-11-03T17:00:00.000Z');
  assert.equal(parseDueAt('2026-11-03T17:00:00-02:00').toISOString(), '2026-11-03T19:00:00.000Z');
  for (const bad of ['2026-02-31', '2026-02-31T10:00', '2026-13-01', 'banana', '', '2026-11-03T25:00']) assert.throws(() => parseDueAt(bad), codeIs('LEGAL_DEADLINE_VALIDATION'), bad);
  await withRollbackTenantTransaction(tenant, async (t) => {
    const legalCase = await newCase(tenant, t);
    const d = await newDeadline(legalCase.id, tenant, t, { dueAt: '2030-01-01' });
    const [[row]] = await sequelize.query("SELECT to_char(due_at AT TIME ZONE 'America/Sao_Paulo', 'YYYY-MM-DD HH24:MI') AS sp FROM legal.legal_deadlines WHERE id = :id", { replacements: { id: d.id }, transaction: t });
    assert.equal(row.sp, '2030-01-01 23:59', 'vence no fim do dia em Brasília, não às 21:00 do dia anterior');
    await assert.rejects(newDeadline(legalCase.id, tenant, t, { dueAt: '2030-02-30' }), codeIs('LEGAL_DEADLINE_VALIDATION'));
  });
});

test('JR prazo livro: todo prazo tem responsável — sem o próprio e sem o do processo é 400; processo não perde o responsável de que um prazo pendente depende', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const orphanCase = await newCase(tenant, t, { responsibleUserId: null, escalationUserId: null });
    await assert.rejects(newDeadline(orphanCase.id, tenant, t), codeIs('LEGAL_DEADLINE_RESPONSIBLE_REQUIRED'));
    const owner = await newUser(tenant, t);
    const own = await newDeadline(orphanCase.id, tenant, t, { responsibleUserId: owner.id });
    await assert.rejects(update(own.id, { responsibleUserId: null }, t), codeIs('LEGAL_DEADLINE_RESPONSIBLE_REQUIRED'));

    const withOwner = await newCase(tenant, t, { responsibleUserId: owner.id, escalationUserId: null });
    const inherited = await newDeadline(withOwner.id, tenant, t);
    assert.equal(inherited.responsibleUserId, null, 'sem responsável próprio, vale o do processo');
    assert.equal((await taskOf(inherited, t)).assignedToUserId, owner.id, 'a tarefa vai para o responsável efetivo');
    await assert.rejects(legalCasesService.updateLegalCase(withOwner.id, { responsibleUserId: null }, tenant.userId, t), codeIs('LEGAL_DEADLINE_RESPONSIBLE_REQUIRED'));
    // Trocar o responsável do processo reatribui a tarefa do prazo que depende dele.
    const other = await newUser(tenant, t);
    await legalCasesService.updateLegalCase(withOwner.id, { responsibleUserId: other.id }, tenant.userId, t);
    assert.equal((await taskOf(inherited, t)).assignedToUserId, other.id);
  });
});

test('JR prazo livro: origem por sourceFileId (arquivo íntegro da empresa) ou sourceEventId (evento real: outbox ou auditoria); inexistente, sem SHA-256 ou só texto é recusado', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const legalCase = await newCase(tenant, t);
    const file = await fakeFile(tenant, t);
    const byFile = await newDeadline(legalCase.id, tenant, t, { sourceFileId: file.id });
    assert.equal(byFile.sourceFileId, file.id);
    const outbox = await OutboxEvent.findOne({ where: { aggregateId: legalCase.id, eventType: 'legal.case.created' }, transaction: t });
    const byEvent = await newDeadline(legalCase.id, tenant, t, { sourceFileId: undefined, sourceEventId: outbox.id });
    assert.deepEqual([byEvent.sourceEventId, byEvent.sourceEventType], [outbox.id, 'OUTBOX_EVENT']);
    const audit = await AuditLog.findOne({ where: { entityId: legalCase.id, action: 'legal.case.create' }, transaction: t });
    const byAudit = await newDeadline(legalCase.id, tenant, t, { sourceFileId: undefined, sourceEventId: audit.id });
    assert.equal(byAudit.sourceEventType, 'AUDIT_LOG');
    const ghost = '00000000-0000-4000-8000-000000000000';
    await assert.rejects(newDeadline(legalCase.id, tenant, t, { sourceFileId: ghost }), codeIs('LEGAL_DEADLINE_SOURCE_NOT_FOUND'));
    await assert.rejects(newDeadline(legalCase.id, tenant, t, { sourceFileId: undefined, sourceEventId: ghost }), codeIs('LEGAL_DEADLINE_SOURCE_NOT_FOUND'));
    await assert.rejects(newDeadline(legalCase.id, tenant, t, { sourceFileId: 'nao-e-uuid' }), codeIs('LEGAL_DEADLINE_VALIDATION'));
    const semHash = await File.create({ groupId: tenant.groupId, companyId: tenant.companyId, storageKey: `jr/sem-hash-${Date.now()}.pdf`, fileName: 'sem-hash.pdf', mimeType: 'application/pdf', uploadedByUserId: tenant.userId }, { transaction: t });
    await assert.rejects(newDeadline(legalCase.id, tenant, t, { sourceFileId: semHash.id }), codeIs('LEGAL_DEADLINE_SOURCE_NOT_FOUND'));
    await assert.rejects(newDeadline(legalCase.id, tenant, t, { sourceFileId: undefined, sourceDocument: 'Intimação (só texto)' }), codeIs('DEADLINE_SOURCE_REQUIRED'));
  });
});

test('JR prazo livro: a tarefa do responsável nasce com o prazo (LEGAL_DEADLINE, dueAt, prioridade) e acompanha remarcação, reatribuição, conclusão e reabertura (Guia §12)', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const legalCase = await newCase(tenant, t);
    const owner = await newUser(tenant, t);
    const d = await newDeadline(legalCase.id, tenant, t, { criticality: 'HIGH', responsibleUserId: owner.id });
    let task = await taskOf(d, t);
    assert.deepEqual([task.relatedEntityType, task.relatedEntityId, task.status, task.priority, task.assignedToUserId], ['LEGAL_DEADLINE', d.id, 'OPEN', 'HIGH', owner.id]);
    assert.equal(new Date(task.dueAt).getTime(), new Date(d.dueAt).getTime());
    assert.match(task.description, /horário de Brasília/);
    const next = FUTURE(40);
    await update(d.id, { dueAt: next, changeReason: 'Prorrogação deferida' }, t);
    task = await taskOf(d, t);
    assert.equal(new Date(task.dueAt).getTime(), next.getTime());
    const other = await newUser(tenant, t);
    await update(d.id, { responsibleUserId: other.id }, t);
    assert.equal((await taskOf(d, t)).assignedToUserId, other.id);
    await update(d.id, { status: 'DONE', conclusionNote: 'Protocolado.' }, t);
    assert.equal((await taskOf(d, t)).status, 'DONE');
    await update(d.id, { status: 'PENDING' }, t);
    assert.equal((await taskOf(d, t)).status, 'OPEN');
    assert.equal(await Task.count({ where: { relatedEntityType: 'LEGAL_DEADLINE', relatedEntityId: d.id }, transaction: t }), 1, 'uma tarefa por prazo');
  });
});

test('JR prazo livro: cancelar exige motivo, é proibido em legal hold e, pela API, exige legal:approve; cancelado é terminal e a tarefa vira CANCELLED', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const legalCase = await newCase(tenant, t);
    const d = await newDeadline(legalCase.id, tenant, t);
    await assert.rejects(update(d.id, { status: 'CANCELLED' }, t), codeIs('LEGAL_DEADLINE_CANCEL_REASON_REQUIRED'));
    await assert.rejects(update(d.id, { status: 'CANCELLED', changeReason: 'Acordo extinguiu o processo' }, t, ['legal:update']), codeIs('LEGAL_DEADLINE_CANCEL_NOT_ALLOWED'));
    await legalCasesService.setLegalHold(legalCase.id, { legalHold: true, reason: 'Retenção fictícia' }, tenant.userId, t);
    await assert.rejects(update(d.id, { status: 'CANCELLED', changeReason: 'Acordo extinguiu o processo' }, t), codeIs('LEGAL_CASE_ON_LEGAL_HOLD'));
    await legalCasesService.setLegalHold(legalCase.id, { legalHold: false }, tenant.userId, t);
    const cancelled = await update(d.id, { status: 'CANCELLED', changeReason: 'Acordo extinguiu o processo' }, t, ['legal:update', 'legal:approve']);
    assert.deepEqual([cancelled.status, cancelled.cancelReason, Boolean(cancelled.cancelledAt)], ['CANCELLED', 'Acordo extinguiu o processo', true]);
    assert.equal((await taskOf(d, t)).status, 'CANCELLED');
    assert.equal(legalDeadlinesService.computeSeverity(cancelled), 'CANCELLED');
    await assert.rejects(update(d.id, { status: 'PENDING' }, t), codeIs('LEGAL_DEADLINE_INVALID_TRANSITION'));
    await assert.rejects(update(d.id, { description: 'outra' }, t), codeIs('LEGAL_DEADLINE_INVALID_TRANSITION'));
    const done = await newDeadline(legalCase.id, tenant, t);
    await update(done.id, { status: 'DONE', conclusionNote: 'Feito.' }, t);
    await assert.rejects(update(done.id, { status: 'CANCELLED', changeReason: 'x motivo' }, t), codeIs('LEGAL_DEADLINE_INVALID_TRANSITION'));
  });
});

test('JR prazo livro: prazo legado só com texto de origem continua válido e editável; a tarefa que faltava é criada na primeira alteração', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const legalCase = await newCase(tenant, t);
    const legacy = await LegalDeadline.create({ groupId: tenant.groupId, companyId: tenant.companyId, legalCaseId: legalCase.id, description: 'Legado', dueAt: FUTURE(9), sourceDocument: 'Intimação antiga', criticality: 'MEDIUM', status: 'PENDING' }, { transaction: t });
    const changed = await update(legacy.id, { dueAt: FUTURE(12), changeReason: 'Prorrogação do legado' }, t);
    assert.equal(changed.sourceDocument, 'Intimação antiga');
    assert.ok(changed.taskId, 'tarefa criada para o legado pendente');
    assert.equal((await taskOf(changed, t)).relatedEntityType, 'LEGAL_DEADLINE');
  });
});
