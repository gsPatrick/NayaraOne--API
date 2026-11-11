'use strict';

/**
 * Fechamento do Marco 5 — Jurídico, prazos (Caderno M5 §15 e §19, JUR-009). Postgres real com
 * RLS, transação desfeita no fim. O caminho HTTP (criar, atribuir, remarcar, concluir, reabrir) está
 * em m5fech.juridico.rotas.test.js e na captura 31-juridico-prazos.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize, getSeedTenant, withRollbackTenantTransaction } = require('./testHelpers');
const { newUser, newCase, newDeadline, fakeFile, FUTURE, PAST } = require('./m5fech.juridico.helpers');
const legalDeadlinesService = require('../src/features/legal/legalDeadlines.service');
const { AuditLog, LegalDeadline } = require('../src/models');

let tenant;
before(async () => { tenant = await getSeedTenant(); });
after(async () => { await sequelize.close(); });

const codeIs = (code) => (err) => { assert.equal(err.code, code); return true; };
const conclude = (id, actor, permissions, body = { status: 'DONE', conclusionNote: 'Protocolo feito.' }, t) =>
  legalDeadlinesService.updateLegalDeadline(id, body, actor, t, { actorPermissions: permissions });

test('JR prazo: quem não é responsável nem tem legal:approve não conclui (403 LEGAL_DEADLINE_NOT_RESPONSIBLE); o responsável e quem tem legal:approve concluem (§19)', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const owner = await newUser(tenant, t);
    const outsider = await newUser(tenant, t);
    const legalCase = await newCase(tenant, t, { responsibleUserId: null, escalationUserId: null });
    const d1 = await newDeadline(legalCase.id, tenant, t, { responsibleUserId: owner.id });
    await assert.rejects(conclude(d1.id, outsider.id, ['legal:read', 'legal:update'], undefined, t), codeIs('LEGAL_DEADLINE_NOT_RESPONSIBLE'));
    // Atribuir-se o prazo e concluir na mesma chamada não contorna a regra.
    await assert.rejects(conclude(d1.id, outsider.id, ['legal:update'], { status: 'DONE', conclusionNote: 'x feito', responsibleUserId: outsider.id }, t), codeIs('LEGAL_DEADLINE_NOT_RESPONSIBLE'));
    assert.equal((await LegalDeadline.findByPk(d1.id, { transaction: t })).status, 'PENDING');
    const done = await conclude(d1.id, owner.id, ['legal:update'], undefined, t);
    assert.equal(done.status, 'DONE');

    const d2 = await newDeadline(legalCase.id, tenant, t, { responsibleUserId: owner.id });
    const byApprover = await conclude(d2.id, outsider.id, ['legal:update', 'legal:approve'], undefined, t);
    assert.equal(byApprover.status, 'DONE');

    // Sem responsável no prazo, vale o responsável do processo.
    const caseWithOwner = await newCase(tenant, t, { responsibleUserId: owner.id });
    const d3 = await newDeadline(caseWithOwner.id, tenant, t);
    assert.equal((await conclude(d3.id, owner.id, ['legal:update'], undefined, t)).status, 'DONE');
  });
});

test('JR prazo: concluir exige evidência ou nota com texto; evidência de outra empresa/inexistente é recusada (§15 "Conclusão exige evidência/nota")', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const legalCase = await newCase(tenant, t);
    const d = await newDeadline(legalCase.id, tenant, t);
    await assert.rejects(conclude(d.id, tenant.userId, ['legal:approve'], { status: 'DONE' }, t), codeIs('LEGAL_DEADLINE_CONCLUSION_PROOF_REQUIRED'));
    await assert.rejects(conclude(d.id, tenant.userId, ['legal:approve'], { status: 'DONE', conclusionNote: '   ' }, t), codeIs('LEGAL_DEADLINE_CONCLUSION_PROOF_REQUIRED'));
    await assert.rejects(conclude(d.id, tenant.userId, ['legal:approve'], { status: 'DONE', conclusionEvidenceFileId: '00000000-0000-4000-8000-000000000000' }, t), codeIs('LEGAL_DEADLINE_EVIDENCE_FILE_NOT_FOUND'));
    const file = await fakeFile(tenant, t);
    const done = await conclude(d.id, tenant.userId, ['legal:approve'], { status: 'DONE', conclusionEvidenceFileId: file.id }, t);
    assert.equal(done.status, 'DONE');
    assert.equal(done.conclusionEvidenceFileId, file.id);
  });
});

test('JR prazo: remarcar sem motivo é 400; com motivo a auditoria preserva o vencimento anterior e a justificativa (§15)', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const legalCase = await newCase(tenant, t);
    const original = FUTURE(10);
    const d = await newDeadline(legalCase.id, tenant, t, { dueAt: original });
    await assert.rejects(legalDeadlinesService.updateLegalDeadline(d.id, { dueAt: FUTURE(15) }, tenant.userId, t), codeIs('LEGAL_DEADLINE_CHANGE_REASON_REQUIRED'));
    const next = FUTURE(15);
    await legalDeadlinesService.updateLegalDeadline(d.id, { dueAt: next, changeReason: 'Prorrogação deferida' }, tenant.userId, t);
    const log = await AuditLog.findOne({ where: { entityId: d.id, action: 'legal.deadline.update' }, order: [['created_at', 'DESC']], transaction: t });
    assert.equal(log.reason, 'Prorrogação deferida');
    assert.equal(new Date(log.beforeJson.dueAt).getTime(), original.getTime(), 'valor anterior preservado');
    assert.equal(new Date(log.afterJson.dueAt).getTime(), next.getTime());
  });
});

test('JR prazo: responsável atribuído precisa ter vínculo ativo na empresa; severidade é calculada (NORMAL, DUE_SOON, OVERDUE, DONE) (§15)', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const legalCase = await newCase(tenant, t);
    await assert.rejects(newDeadline(legalCase.id, tenant, t, { responsibleUserId: '00000000-0000-4000-8000-000000000000' }), codeIs('LEGAL_DEADLINE_RESPONSIBLE_NOT_IN_TENANT'));
    const user = await newUser(tenant, t);
    const d = await newDeadline(legalCase.id, tenant, t);
    const assigned = await legalDeadlinesService.updateLegalDeadline(d.id, { responsibleUserId: user.id, changeReason: 'Redistribuição' }, tenant.userId, t);
    assert.equal(assigned.responsibleUserId, user.id);
    const now = new Date();
    assert.equal(legalDeadlinesService.computeSeverity({ status: 'PENDING', dueAt: FUTURE(10) }, now), 'NORMAL');
    assert.equal(legalDeadlinesService.computeSeverity({ status: 'PENDING', dueAt: new Date(now.getTime() + 3600000) }, now), 'DUE_SOON');
    assert.equal(legalDeadlinesService.computeSeverity({ status: 'PENDING', dueAt: PAST(1) }, now), 'OVERDUE');
    assert.equal(legalDeadlinesService.computeSeverity({ status: 'DONE', dueAt: PAST(1) }, now), 'DONE');
  });
});

test('JR prazo: crítico exige origem, responsável efetivo e escalonamento (JUR-009); reabrir crítico concluído reavalia a regra', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const noEscalation = await newCase(tenant, t, { escalationUserId: null });
    await assert.rejects(newDeadline(noEscalation.id, tenant, t, { criticality: 'CRITICAL' }), codeIs('LEGAL_DEADLINE_CRITICAL_ESCALATION_REQUIRED'));
    const noResponsible = await newCase(tenant, t, { responsibleUserId: null });
    await assert.rejects(newDeadline(noResponsible.id, tenant, t, { criticality: 'CRITICAL' }), codeIs('LEGAL_DEADLINE_CRITICAL_RESPONSIBLE_REQUIRED'));
    await assert.rejects(newDeadline(noResponsible.id, tenant, t, { criticality: 'CRITICAL', sourceDocument: undefined, sourceFileId: undefined, responsibleUserId: tenant.userId }), codeIs('DEADLINE_SOURCE_REQUIRED'));
    const ok = await newCase(tenant, t);
    const d = await newDeadline(ok.id, tenant, t, { criticality: 'CRITICAL' });
    await legalDeadlinesService.updateLegalDeadline(d.id, { status: 'DONE', conclusionNote: 'Feito.' }, tenant.userId, t);
    const reopened = await legalDeadlinesService.updateLegalDeadline(d.id, { status: 'PENDING' }, tenant.userId, t);
    assert.equal(reopened.status, 'PENDING');
    assert.equal(reopened.lastAlertedSeverity, null, 'reabrir reinicia o ciclo de alerta');
  });
});
