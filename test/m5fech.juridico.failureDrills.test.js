'use strict';

/**
 * Failure drills do Jurídico (Marco 5, Guia do Marcelo sprint J10 "Falhas, carga, segurança e pentest"). Mesmo padrão de
 * inventory.failureDrills.test.js e construction.failureDrills.test.js: cada drill força uma falha de verdade NO MEIO de
 * uma operação real, em transação COMMITADA (conexões próprias, SET LOCAL do tenant), e prova que nada fica pela metade
 * e que repetir não duplica.
 *   Drill 1 — criação de prazo: a gravação da TAREFA cai depois de o prazo já ter sido escrito na transação. Nenhum
 *     prazo, nenhuma tarefa, nenhum evento, nenhuma auditoria; o retry cria 1 prazo com 1 tarefa.
 *   Drill 2 — recebível do processo: o vínculo cai depois de o lançamento RECEIVABLE já ter sido criado. Nenhum
 *     lançamento órfão; o retry cria 1 lançamento e 1 vínculo; um 2º pedido é 409.
 *   Drill 3 — job de prazos repetido (o "webhook repetido" do Jurídico: o mesmo disparo chegando de novo): 5 rodadas
 *     seguidas = 1 ocorrência, 1 evento legal.deadline.overdue e 1 aviso ao responsável.
 *   Drill 4 — duas instâncias do job em paralelo (2 conexões) sobre o mesmo prazo vencido: uma ocorrência, um evento,
 *     um escalonamento.
 *   Drill 5 — job x conclusão ao mesmo tempo: com o prazo travado pela conclusão, o job não o alerta nem escala.
 * Como COMMITAM dados, só rodam em banco descartável (DISPOSABLE_DB=1) ou no CI.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const canRun = Boolean(process.env.DISPOSABLE_DB || process.env.CI);
const skip = canRun ? false : 'commita dados: rode com scripts/withDisposableDb.js (ou no CI)';

const { sequelize, getSeedTenant, withTenantTransaction, createTestResultCenter, uniqueSuffix } = require('./testHelpers');
const { newUser, newCase, newDeadline, PAST } = require('./m5fech.juridico.helpers');
const legalDeadlinesService = require('../src/features/legal/legalDeadlines.service');
const legalCasesService = require('../src/features/legal/legalCases.service');
const receivables = require('../src/features/legal/legalCaseReceivables.service');
const { processDeadlinesInTransaction } = require('../src/engines/jobs/legalDeadlineAlertJob');
const { LegalDeadline, Task, OutboxEvent, AuditLog, FinancialEntry, Notification } = require('../src/models');

let tenant;
before(async () => { if (canRun) tenant = await getSeedTenant(); });
after(async () => { await sequelize.close(); });

const T = (fn) => withTenantTransaction(tenant, fn);
const SIMULATED = 'FALHA SIMULADA (drill)';

/** Substitui temporariamente target[method]; `shouldFail(args)` decide quando lançar. */
function injectFailure(target, method, shouldFail) {
  const original = target[method];
  target[method] = function injected(...args) {
    if (shouldFail(args)) return Promise.reject(new Error(SIMULATED));
    return original.apply(this, args);
  };
  return () => { target[method] = original; };
}

test('Drill 1: falha ao gravar a tarefa no meio da criação do prazo não deixa prazo, evento nem auditoria; retry cria 1 prazo com 1 tarefa', { skip }, async () => {
  const { legalCase, description } = await T(async (t) => ({ legalCase: await newCase(tenant, t), description: `Drill prazo ${uniqueSuffix()}` }));
  const restore = injectFailure(Task, 'create', ([values]) => values && values.relatedEntityType === 'LEGAL_DEADLINE');
  try {
    await assert.rejects(T((t) => newDeadline(legalCase.id, tenant, t, { description })), /FALHA SIMULADA/);
  } finally {
    restore();
  }
  const counts = () => T(async (t) => {
    const ids = (await LegalDeadline.findAll({ where: { legalCaseId: legalCase.id, description }, transaction: t })).map((d) => d.id);
    return {
      prazos: ids.length,
      tarefas: ids.length ? await Task.count({ where: { relatedEntityType: 'LEGAL_DEADLINE', relatedEntityId: ids }, transaction: t }) : 0,
      eventos: ids.length ? await OutboxEvent.count({ where: { aggregateId: ids, eventType: 'legal.deadline.created' }, transaction: t }) : 0,
      auditorias: ids.length ? await AuditLog.count({ where: { entityId: ids, action: 'legal.deadline.create' }, transaction: t }) : 0,
    };
  });
  assert.deepEqual(await counts(), { prazos: 0, tarefas: 0, eventos: 0, auditorias: 0 }, 'nada ficou pela metade');
  await T((t) => newDeadline(legalCase.id, tenant, t, { description }));
  assert.deepEqual(await counts(), { prazos: 1, tarefas: 1, eventos: 1, auditorias: 1 });
});

test('Drill 2: falha no vínculo do recebível depois do lançamento criado não deixa lançamento órfão; retry vincula uma vez e o 2º pedido é 409', { skip }, async () => {
  const fx = await T(async (t) => {
    const rc = await createTestResultCenter(tenant, t);
    const legalCase = await newCase(tenant, t);
    await legalCasesService.updateLegalCase(legalCase.id, { confirmedAmount: 1234.56 }, tenant.userId, t);
    return { legalCase, body: { basis: 'FINAL_JUDGMENT', basisReference: `Sentença fictícia ${uniqueSuffix()}`, dueAt: '2030-05-20', resultCenterId: rc.id } };
  });
  const origin = `legal.legal_cases:${fx.legalCase.id}`;
  const entries = () => T((t) => FinancialEntry.count({ where: { originRef: origin }, transaction: t }));
  const restore = injectFailure(sequelize, 'query', ([sql]) => typeof sql === 'string' && sql.includes('INSERT INTO legal.case_receivables'));
  try {
    await assert.rejects(T((t) => receivables.linkCaseReceivable(fx.legalCase.id, fx.body, tenant.userId, t)), /FALHA SIMULADA/);
  } finally {
    restore();
  }
  assert.equal(await entries(), 0, 'o lançamento criado antes da falha foi desfeito junto');
  await T((t) => receivables.linkCaseReceivable(fx.legalCase.id, fx.body, tenant.userId, t));
  assert.equal(await entries(), 1);
  await assert.rejects(T((t) => receivables.linkCaseReceivable(fx.legalCase.id, fx.body, tenant.userId, t)), (err) => err.code === 'LEGAL_CASE_RECEIVABLE_DUPLICATE');
  assert.equal(await entries(), 1);
});

async function overdueCritical() {
  return T(async (t) => {
    const owner = await newUser(tenant, t);
    const escalation = await newUser(tenant, t);
    const legalCase = await newCase(tenant, t, { responsibleUserId: owner.id, escalationUserId: escalation.id });
    const d = await newDeadline(legalCase.id, tenant, t, { criticality: 'CRITICAL', dueAt: PAST(2), responsibleUserId: owner.id });
    return { d, owner, escalation };
  });
}

const effects = (fx) => T(async (t) => ({
  ocorrencias: await Task.count({ where: { relatedEntityType: 'legal.legal_deadlines', relatedEntityId: fx.d.id }, transaction: t }),
  eventos: await OutboxEvent.count({ where: { aggregateId: fx.d.id, eventType: 'legal.deadline.overdue' }, transaction: t }),
  avisos: await Notification.count({ where: { userId: fx.owner.id }, transaction: t }),
  escalonamentos: await Notification.count({ where: { userId: fx.escalation.id }, transaction: t }),
}));

test('Drill 3: o mesmo disparo do job de prazos repetido 5 vezes não duplica ocorrência, evento nem aviso', { skip }, async () => {
  const fx = await overdueCritical();
  const now = new Date();
  for (let i = 0; i < 5; i += 1) await T((t) => processDeadlinesInTransaction(t, new Date(now.getTime() + i * 1000)));
  assert.deepEqual(await effects(fx), { ocorrencias: 1, eventos: 1, avisos: 1, escalonamentos: 0 });
});

test('Drill 4: duas instâncias do job em paralelo (2 conexões) sobre o mesmo prazo vencido: uma ocorrência, um evento, um escalonamento', { skip }, async () => {
  const fx = await overdueCritical();
  const now = new Date();
  await Promise.all([T((t) => processDeadlinesInTransaction(t, now)), T((t) => processDeadlinesInTransaction(t, now))]);
  const later = new Date(now.getTime() + 25 * 3600000);
  await Promise.all([T((t) => processDeadlinesInTransaction(t, later)), T((t) => processDeadlinesInTransaction(t, later))]);
  assert.deepEqual(await effects(fx), { ocorrencias: 1, eventos: 1, avisos: 1, escalonamentos: 1 });
});

test('Drill 5: job e conclusão ao mesmo tempo — com o prazo travado pela conclusão, o job não o alerta; concluído, nunca mais', { skip }, async () => {
  const fx = await overdueCritical();
  let releaseConclusion;
  const held = new Promise((resolve) => { releaseConclusion = resolve; });
  let locked;
  const lockedSignal = new Promise((resolve) => { locked = resolve; });
  const conclusion = T(async (t) => {
    await LegalDeadline.findByPk(fx.d.id, { transaction: t, lock: t.LOCK.UPDATE });
    locked();
    await held;
    return legalDeadlinesService.updateLegalDeadline(fx.d.id, { status: 'DONE', conclusionNote: 'Recurso protocolado (drill).' }, tenant.userId, t);
  });
  await lockedSignal;
  await T((t) => processDeadlinesInTransaction(t, new Date()));
  releaseConclusion();
  await conclusion;
  await T((t) => processDeadlinesInTransaction(t, new Date(Date.now() + 25 * 3600000)));
  assert.deepEqual(await effects(fx), { ocorrencias: 0, eventos: 0, avisos: 0, escalonamentos: 0 });
  assert.equal((await T((t) => LegalDeadline.findByPk(fx.d.id, { transaction: t }))).status, 'DONE');
});
