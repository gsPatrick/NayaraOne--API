'use strict';

/**
 * Carga curta e determinística do Jurídico (Guia do Marcelo sprint J10 "Falhas, carga, segurança e pentest"). Conexões
 * próprias em paralelo, transações COMMITADAS; ao fim, as invariantes do livro continuam valendo:
 *   - 20 prazos criados ao mesmo tempo no MESMO processo: 20 prazos, 20 tarefas (1:1), 20 eventos legal.deadline.created,
 *     todos com origem verificável e responsável;
 *   - 8 processos criados em paralelo, cada um com 3 prazos: nenhum prazo cai no processo errado;
 *   - 10 conclusões simultâneas do mesmo prazo: termina DONE, a tarefa DONE e um único evento de conclusão;
 *   - 10 remarcações simultâneas do mesmo prazo: o vencimento final é o de uma delas e a tarefa tem o mesmo vencimento;
 *     cada remarcação aplicada tem sua linha de auditoria com o anterior e o motivo.
 * Só roda em banco descartável (DISPOSABLE_DB=1) ou no CI.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const canRun = Boolean(process.env.DISPOSABLE_DB || process.env.CI);
const skip = canRun ? false : 'commita dados: rode com scripts/withDisposableDb.js (ou no CI)';

const { sequelize, getSeedTenant, withTenantTransaction, uniqueSuffix } = require('./testHelpers');
const { newCase, newDeadline, FUTURE } = require('./m5fech.juridico.helpers');
const legalDeadlinesService = require('../src/features/legal/legalDeadlines.service');
const { LegalDeadline, Task, OutboxEvent, AuditLog } = require('../src/models');

let tenant;
before(async () => { if (canRun) tenant = await getSeedTenant(); });
after(async () => { await sequelize.close(); });

const T = (fn) => withTenantTransaction(tenant, fn);
const range = (n) => Array.from({ length: n }, (_, i) => i);

test('Carga: 20 prazos ao mesmo tempo no mesmo processo — 20 prazos, 20 tarefas 1:1, 20 eventos, origem e responsável em todos', { skip }, async () => {
  const legalCase = await T((t) => newCase(tenant, t));
  const tag = uniqueSuffix();
  await Promise.all(range(20).map((i) => T((t) => newDeadline(legalCase.id, tenant, t, { description: `Carga ${tag} #${i}`, dueAt: FUTURE(5 + i) }))));
  await T(async (t) => {
    const deadlines = await LegalDeadline.findAll({ where: { legalCaseId: legalCase.id }, transaction: t });
    assert.equal(deadlines.length, 20);
    assert.ok(deadlines.every((d) => d.sourceFileId && d.taskId && (d.responsibleUserId || legalCase.responsibleUserId)));
    const tasks = await Task.findAll({ where: { relatedEntityType: 'LEGAL_DEADLINE', relatedEntityId: deadlines.map((d) => d.id) }, transaction: t });
    assert.equal(tasks.length, 20);
    assert.equal(new Set(tasks.map((x) => x.relatedEntityId)).size, 20, 'uma tarefa por prazo');
    assert.equal(await OutboxEvent.count({ where: { aggregateId: deadlines.map((d) => d.id), eventType: 'legal.deadline.created' }, transaction: t }), 20);
  });
});

test('Carga: 8 processos em paralelo com 3 prazos cada — nenhum prazo no processo errado', { skip }, async () => {
  const tag = uniqueSuffix();
  const cases = await Promise.all(range(8).map((i) => T(async (t) => {
    const legalCase = await newCase(tenant, t, { caseNumber: `CARGA-${tag}-${i}` });
    for (const k of range(3)) await newDeadline(legalCase.id, tenant, t, { description: `Carga ${tag} p${i} #${k}` });
    return legalCase;
  })));
  await T(async (t) => {
    for (const [i, legalCase] of cases.entries()) {
      const deadlines = await LegalDeadline.findAll({ where: { legalCaseId: legalCase.id }, transaction: t });
      assert.equal(deadlines.length, 3);
      assert.ok(deadlines.every((d) => d.description.startsWith(`Carga ${tag} p${i} `)));
    }
  });
});

test('Carga: 10 conclusões e 10 remarcações simultâneas do mesmo prazo — estado final coerente, tarefa alinhada, um evento de conclusão', { skip }, async () => {
  const fx = await T(async (t) => {
    const legalCase = await newCase(tenant, t);
    return { a: await newDeadline(legalCase.id, tenant, t), b: await newDeadline(legalCase.id, tenant, t) };
  });
  const conclude = await Promise.allSettled(range(10).map((i) => T((t) => legalDeadlinesService.updateLegalDeadline(fx.a.id, { status: 'DONE', conclusionNote: `Protocolo carga #${i}` }, tenant.userId, t))));
  assert.ok(conclude.every((r) => r.status === 'fulfilled'), JSON.stringify(conclude.filter((r) => r.status === 'rejected').map((r) => r.reason.message)));
  const dates = range(10).map((i) => FUTURE(30 + i));
  const moves = await Promise.allSettled(dates.map((d, i) => T((t) => legalDeadlinesService.updateLegalDeadline(fx.b.id, { dueAt: d, changeReason: `Remarcação carga #${i}` }, tenant.userId, t))));
  assert.ok(moves.every((r) => r.status === 'fulfilled'));
  await T(async (t) => {
    const a = await LegalDeadline.findByPk(fx.a.id, { transaction: t });
    assert.equal(a.status, 'DONE');
    assert.equal((await Task.findByPk(a.taskId, { transaction: t })).status, 'DONE');
    assert.equal(await OutboxEvent.count({ where: { aggregateId: a.id, eventType: 'legal.deadline.completed' }, transaction: t }), 1, 'concluir de novo não reemite a conclusão');
    const b = await LegalDeadline.findByPk(fx.b.id, { transaction: t });
    assert.ok(dates.some((d) => d.getTime() === new Date(b.dueAt).getTime()), 'o vencimento final é o de uma das remarcações');
    assert.equal(new Date((await Task.findByPk(b.taskId, { transaction: t })).dueAt).getTime(), new Date(b.dueAt).getTime(), 'tarefa com o mesmo vencimento');
    const audits = await AuditLog.findAll({ where: { entityId: b.id, action: 'legal.deadline.update' }, transaction: t });
    assert.equal(audits.filter((x) => /^Remarcação carga #\d$/.test(x.reason)).length, 10, 'cada remarcação tem sua linha com o motivo');
    assert.ok(audits.every((x) => x.beforeJson && x.beforeJson.dueAt), 'e o vencimento anterior');
  });
});
