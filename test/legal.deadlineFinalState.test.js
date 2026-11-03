'use strict';

/**
 * Reteste da IA da cliente (PATCH de prazo juridico): as invariantes valem sobre o estado FINAL
 * da requisicao (status + responsavel + vencimento + criticidade), nao sobre o estado anterior.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { getSeedTenant, withRollbackTenantTransaction, uniqueSuffix } = require('./testHelpers');
const { sequelize, FUTURE, PAST, newUser, concludedCriticalWithoutCaseResponsible: setup, snapshot } = require('./legal.deadlineFinalState.helpers');
const legalCasesService = require('../src/features/legal/legalCases.service');
const legalDeadlinesService = require('../src/features/legal/legalDeadlines.service');
const AppError = require('../src/utils/AppError');
const { LegalCase } = require('../src/models');

let tenant;
before(async () => {
  tenant = await getSeedTenant();
});
after(async () => {
  await sequelize.close();
});

function expectCode(code, status) {
  return (err) => {
    assert.ok(err instanceof AppError, String(err));
    assert.equal(err.code, code);
    assert.equal(err.statusCode, status);
    return true;
  };
}
const patch = (id, body, t) => legalDeadlinesService.updateLegalDeadline(id, body, tenant.userId, t);

test('Cenario 1: reabrir CRITICAL retirando o unico responsavel na mesma requisicao -> 422 e estado preservado', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const a = await newUser(tenant, t);
    const { d } = await setup(tenant, t, { responsibleUserId: a.id });
    const before = await snapshot(d.id, t);
    await assert.rejects(() => patch(d.id, { status: 'PENDING', responsibleUserId: null }, t), expectCode('LEGAL_DEADLINE_CRITICAL_RESPONSIBLE_REQUIRED', 422));
    assert.deepEqual(await snapshot(d.id, t), before);
    assert.equal(before.status, 'DONE');
    assert.equal(before.responsibleUserId, a.id);
  });
});

test('Cenario 2: reabrir CRITICAL sem responsavel atribuindo B valido na mesma requisicao -> permitido', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const b = await newUser(tenant, t);
    const { d } = await setup(tenant, t, {});
    const out = await patch(d.id, { status: 'PENDING', responsibleUserId: b.id }, t);
    assert.equal(out.status, 'PENDING');
    const s = await snapshot(d.id, t);
    assert.equal(s.status, 'PENDING');
    assert.equal(s.responsibleUserId, b.id);
  });
});

test('Cenario 2b: B sem vinculo ativo continua recusado (422 LEGAL_DEADLINE_RESPONSIBLE_NOT_IN_TENANT) e estado preservado', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const { d } = await setup(tenant, t, {});
    const before = await snapshot(d.id, t);
    await assert.rejects(
      () => patch(d.id, { status: 'PENDING', responsibleUserId: '00000000-0000-4000-8000-000000000001' }, t),
      expectCode('LEGAL_DEADLINE_RESPONSIBLE_NOT_IN_TENANT', 422)
    );
    assert.deepEqual(await snapshot(d.id, t), before);
  });
});

test('Reabrir CRITICAL sem mexer no responsavel (A mantido) -> permitido', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const a = await newUser(tenant, t);
    const { d } = await setup(tenant, t, { responsibleUserId: a.id });
    const out = await patch(d.id, { status: 'PENDING' }, t);
    assert.equal(out.status, 'PENDING');
    assert.equal((await snapshot(d.id, t)).responsibleUserId, a.id);
  });
});

test('Reabrir CRITICAL com responsavel null no prazo, mas o processo tem responsavel proprio -> permitido (efetivo vem do processo)', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const a = await newUser(tenant, t);
    const { d } = await setup(tenant, t, { responsibleUserId: a.id, caseResponsible: true });
    const out = await patch(d.id, { status: 'PENDING', responsibleUserId: null }, t);
    assert.equal(out.status, 'PENDING');
    const s = await snapshot(d.id, t);
    assert.equal(s.status, 'PENDING');
    assert.equal(s.responsibleUserId, null);
  });
});

test('Remover responsavel de CRITICAL DONE sem reabrir -> permitido', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const a = await newUser(tenant, t);
    const { d } = await setup(tenant, t, { responsibleUserId: a.id });
    await patch(d.id, { responsibleUserId: null }, t);
    const s = await snapshot(d.id, t);
    assert.equal(s.status, 'DONE');
    assert.equal(s.responsibleUserId, null);
  });
});

test('Reabrir com status em minusculas ("pending") tambem avalia o estado final; status invalido -> 400', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const a = await newUser(tenant, t);
    const { d } = await setup(tenant, t, { responsibleUserId: a.id });
    await assert.rejects(() => patch(d.id, { status: ' pending ', responsibleUserId: null }, t), expectCode('LEGAL_DEADLINE_CRITICAL_RESPONSIBLE_REQUIRED', 422));
    await assert.rejects(() => patch(d.id, { status: 'REOPENED', responsibleUserId: null }, t), expectCode('LEGAL_DEADLINE_VALIDATION', 400));
    await assert.rejects(() => patch(d.id, { status: null }, t), expectCode('LEGAL_DEADLINE_VALIDATION', 400));
    assert.equal((await snapshot(d.id, t)).status, 'DONE');
  });
});

test('Reabrir CRITICAL sem escalonamento no processo continua 422 (LEGAL_DEADLINE_CRITICAL_ESCALATION_REQUIRED), mesmo com B', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const b = await newUser(tenant, t);
    const { d } = await setup(tenant, t, { escalation: false });
    await assert.rejects(() => patch(d.id, { status: 'PENDING', responsibleUserId: b.id }, t), expectCode('LEGAL_DEADLINE_CRITICAL_ESCALATION_REQUIRED', 422));
    assert.equal((await snapshot(d.id, t)).status, 'DONE');
  });
});

test('PENDING com dueAt vencido e responsavel removido na mesma requisicao -> 400 e estado preservado; mantendo o responsavel -> permitido', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const a = await newUser(tenant, t);
    const legalCase = await legalCasesService.createLegalCase(
      { groupId: tenant.groupId, companyId: tenant.companyId, caseType: 'LITIGATION', summary: `Venc ${uniqueSuffix()}`, responsibleUserId: tenant.userId },
      tenant.userId,
      t
    );
    const d = await legalDeadlinesService.createLegalDeadline(legalCase.id, { description: 'comum', dueAt: FUTURE(), sourceEvent: 'teste', responsibleUserId: a.id }, tenant.userId, t);
    const before = await snapshot(d.id, t);
    await assert.rejects(
      () => patch(d.id, { dueAt: PAST(), changeReason: 'antecipado', responsibleUserId: null }, t),
      expectCode('LEGAL_DEADLINE_RESPONSIBLE_REQUIRED', 400)
    );
    assert.deepEqual(await snapshot(d.id, t), before);
    await patch(d.id, { dueAt: PAST(), changeReason: 'antecipado' }, t);
    assert.equal((await snapshot(d.id, t)).responsibleUserId, a.id);
    // PENDING ja vencido: tirar o responsavel e recusado (400)
    await assert.rejects(() => patch(d.id, { responsibleUserId: null }, t), expectCode('LEGAL_DEADLINE_RESPONSIBLE_REQUIRED', 400));
    // concluir e tirar o responsavel na mesma requisicao: o estado final e DONE, permitido
    await patch(d.id, { status: 'DONE', conclusionNote: 'ok', responsibleUserId: null }, t);
    assert.equal((await snapshot(d.id, t)).status, 'DONE');
  });
});

test('Reabrir prazo vencido (DONE -> PENDING) retirando o responsavel -> 400', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const a = await newUser(tenant, t);
    const legalCase = await legalCasesService.createLegalCase(
      { groupId: tenant.groupId, companyId: tenant.companyId, caseType: 'LITIGATION', summary: `Venc2 ${uniqueSuffix()}`, responsibleUserId: tenant.userId },
      tenant.userId,
      t
    );
    const d = await legalDeadlinesService.createLegalDeadline(legalCase.id, { description: 'comum', dueAt: FUTURE(), sourceEvent: 'teste', responsibleUserId: a.id }, tenant.userId, t);
    await patch(d.id, { status: 'DONE', conclusionNote: 'ok' }, t);
    await patch(d.id, { dueAt: PAST(), changeReason: 'ajuste' }, t);
    const before = await snapshot(d.id, t);
    await assert.rejects(() => patch(d.id, { status: 'PENDING', responsibleUserId: null }, t), expectCode('LEGAL_DEADLINE_RESPONSIBLE_REQUIRED', 400));
    assert.deepEqual(await snapshot(d.id, t), before);
  });
});

test('Mudar criticality para CRITICAL em PENDING sem responsavel efetivo -> 422; com B na mesma requisicao -> permitido; valor invalido -> 400', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const b = await newUser(tenant, t);
    const legalCase = await legalCasesService.createLegalCase(
      { groupId: tenant.groupId, companyId: tenant.companyId, caseType: 'LITIGATION', summary: `Crit ${uniqueSuffix()}`, responsibleUserId: tenant.userId, escalationUserId: tenant.userId },
      tenant.userId,
      t
    );
    const d = await legalDeadlinesService.createLegalDeadline(legalCase.id, { description: 'comum', dueAt: FUTURE(), sourceEvent: 'teste' }, tenant.userId, t);
    await LegalCase.update({ responsibleUserId: null }, { where: { id: legalCase.id }, transaction: t });
    const before = await snapshot(d.id, t);
    await assert.rejects(() => patch(d.id, { criticality: 'critical' }, t), expectCode('LEGAL_DEADLINE_CRITICAL_RESPONSIBLE_REQUIRED', 422));
    assert.deepEqual(await snapshot(d.id, t), before);
    await assert.rejects(() => patch(d.id, { criticality: 'URGENTE' }, t), expectCode('LEGAL_DEADLINE_VALIDATION', 400));
    await patch(d.id, { criticality: 'CRITICAL', responsibleUserId: b.id }, t);
    const s = await snapshot(d.id, t);
    assert.equal(s.criticality, 'CRITICAL');
    assert.equal(s.responsibleUserId, b.id);
    // CRITICAL pendente com B: retirar B (sem responsavel do processo) -> 422
    await assert.rejects(() => patch(d.id, { responsibleUserId: null }, t), expectCode('LEGAL_DEADLINE_CRITICAL_RESPONSIBLE_REQUIRED', 422));
  });
});

test('Criacao: CRITICAL sem responsavel efetivo -> 422; vencido sem responsavel -> 400', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const legalCase = await legalCasesService.createLegalCase(
      { groupId: tenant.groupId, companyId: tenant.companyId, caseType: 'LITIGATION', summary: `Cria ${uniqueSuffix()}`, escalationUserId: tenant.userId },
      tenant.userId,
      t
    );
    const create = (extra) => legalDeadlinesService.createLegalDeadline(legalCase.id, { description: 'x', dueAt: FUTURE(), sourceEvent: 'teste', ...extra }, tenant.userId, t);
    await assert.rejects(() => create({ criticality: 'CRITICAL' }), expectCode('LEGAL_DEADLINE_CRITICAL_RESPONSIBLE_REQUIRED', 422));
    await assert.rejects(() => create({ dueAt: PAST() }), expectCode('LEGAL_DEADLINE_RESPONSIBLE_REQUIRED', 400));
    await assert.rejects(() => create({ criticality: 'X' }), expectCode('LEGAL_DEADLINE_VALIDATION', 400));
  });
});
