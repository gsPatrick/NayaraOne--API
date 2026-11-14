'use strict';

/**
 * Falhas REAIS no meio da transação de Obras (Guia M6 §13 "load/failure tests"; Caderno §14 "failure drills"; sprint O9).
 * Diferente dos DRILL 1/2 de construction.failureDrills.test.js (exceção simulada por mock), aqui a conexão com o PostgreSQL
 * da própria transação é ENCERRADA pelo administrador do banco descartável (pg_terminate_backend) depois que a operação já
 * gravou parte do trabalho. Cada teste prova: (1) a queda foi no meio (o que a transação já tinha gravado, lido nela mesma);
 * (2) rollback completo (nada sobrou, lido como superusuário, sem RLS); (3) a aplicação se recupera: a mesma operação, de novo,
 * termina certa e uma vez só. Só em banco descartável (DISPOSABLE_DB=1 + DATABASE_ADMIN_URL).
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const H = require('./helpers/obrasCarga');
const { OutboxEvent, AuditLog } = require('../src/models');
const financialEntriesService = require('../src/modules/finance/application/services/financial-entry.service');
const receiptService = require('../src/modules/finance/application/services/receipt.service');
const filesService = require('../src/features/files/files.service');

const pular = H.podeRodar && process.env.DATABASE_ADMIN_URL ? false : 'falha real: só no banco descartável (scripts/withDisposableDb.js), que fornece DATABASE_ADMIN_URL';
let tenant;
before(async () => { if (!pular) tenant = await H.getSeedTenant(); });
after(async () => { await H.sequelize.close(); });

const transacaoNasOpcoes = (args) => args[1] && args[1].transaction;
const lerNa = async (t, sql, replacements) => (await H.sequelize.query(sql, { replacements, transaction: t }))[0][0];

test('FALHA REAL 1 — conexão cai na aprovação da medição depois de gravar APPROVED e antes da conta a pagar: volta a REVIEWED, sem conta, sem evento; a nova tentativa gera UMA conta', { skip: pular }, async () => {
  const fx = await H.medicaoRevisada(tenant, 'queda na aprovação', 4321.09);
  const queda = H.derrubarConexaoAntes(financialEntriesService, 'createFinancialEntry', (args) => args[2],
    (t) => lerNa(t, 'SELECT status FROM construction.stage_measurements WHERE id = :id', { id: fx.measurementId }));
  try {
    await assert.rejects(() => H.comCommit(tenant, (t) => H.aprovar(tenant, fx.measurementId, t)));
  } finally {
    queda.restaurar();
  }
  assert.ok(queda.estado.derrubou, 'o processo do PostgreSQL da transação foi encerrado');
  assert.equal(queda.estado.antes.status, 'APPROVED', 'a queda foi no meio: a transação já tinha gravado APPROVED');
  const [med] = await H.linhaAdmin('SELECT status, payable_financial_entry_id AS p, approved_at FROM construction.stage_measurements WHERE id = $1', [fx.measurementId]);
  assert.deepEqual({ status: med.status, p: med.p, aprovadaEm: med.approved_at }, { status: 'REVIEWED', p: null, aprovadaEm: null });
  const chave = `measurement.payable:${fx.measurementId}`;
  assert.equal((await H.linhaAdmin('SELECT id FROM finance.financial_entries WHERE idempotency_key = $1', [chave])).length, 0, 'nenhuma conta sobreviveu');
  assert.equal((await H.linhaAdmin("SELECT id FROM integration.outbox_events WHERE event_type = 'measurement.approved' AND aggregate_id = $1", [fx.measurementId])).length, 0);
  const ok = await H.comCommit(tenant, (t) => H.aprovar(tenant, fx.measurementId, t));
  assert.equal(ok.status, 'PAYABLE');
  assert.equal((await H.linhaAdmin('SELECT id FROM finance.financial_entries WHERE idempotency_key = $1', [chave])).length, 1, 'recuperação: uma conta, não duas');
});

test('FALHA REAL 2 — conexão cai na baixa da conta da medição depois de gravar SETTLED e antes do evento: conta volta a PENDING, sem auditoria nem evento; a nova baixa vale uma vez', { skip: pular }, async () => {
  const fx = await H.contaDaMedicaoProntaParaBaixa(tenant, 'queda na baixa', 2222.22);
  const queda = H.derrubarConexaoAntes(OutboxEvent, 'create', transacaoNasOpcoes,
    (t) => lerNa(t, 'SELECT status FROM finance.financial_entries WHERE id = :id', { id: fx.entryId }));
  try {
    await assert.rejects(() => H.comCommit(tenant, (t) => receiptService.settleFinancialEntry(fx.entryId, tenant.userId, t, { manualSettlement: fx.manualSettlement })));
  } finally {
    queda.restaurar();
  }
  assert.ok(queda.estado.derrubou);
  assert.equal(queda.estado.antes.status, 'SETTLED', 'a queda foi no meio: a transação já tinha gravado SETTLED');
  const [conta] = await H.linhaAdmin('SELECT status, settled_at FROM finance.financial_entries WHERE id = $1', [fx.entryId]);
  assert.deepEqual({ status: conta.status, pagaEm: conta.settled_at }, { status: 'PENDING', pagaEm: null });
  assert.equal((await H.linhaAdmin("SELECT id FROM audit.audit_log WHERE action = 'finance.entry.settle' AND entity_id = $1", [fx.entryId])).length, 0);
  assert.equal((await H.linhaAdmin("SELECT id FROM integration.outbox_events WHERE event_type = 'finance.entry.settled' AND aggregate_id = $1", [fx.entryId])).length, 0);
  await H.comCommit(tenant, (t) => receiptService.settleFinancialEntry(fx.entryId, tenant.userId, t, { manualSettlement: fx.manualSettlement }));
  assert.equal((await H.linhaAdmin('SELECT status FROM finance.financial_entries WHERE id = $1', [fx.entryId]))[0].status, 'SETTLED');
  assert.equal((await H.linhaAdmin("SELECT id FROM integration.outbox_events WHERE event_type = 'finance.entry.settled' AND aggregate_id = $1", [fx.entryId])).length, 1);
});

test('FALHA REAL 3 — conexão cai na gravação do diário depois de gravar o RDO e os materiais e antes do evento: nada do diário sobra; o reenvio grava um RDO só', { skip: pular }, async () => {
  const { project } = await H.comCommit(tenant, (t) => H.obraComEtapa(tenant, t, 'queda no diário'));
  const rdo = H.W(tenant, {
    reportDate: '2026-11-05', shiftCode: 'MANHA', workforceCount: 7, servicesPerformed: 'Alvenaria do 2º pavimento', idempotencyKey: `o9-rdo-${crypto.randomUUID()}`,
    materials: [{ materialDescription: 'Bloco cerâmico', quantity: 400, unit: 'UN' }, { materialDescription: 'Argamassa', quantity: 12, unit: 'SC' }],
  });
  const queda = H.derrubarConexaoAntes(OutboxEvent, 'create', transacaoNasOpcoes, (t) => lerNa(t, `SELECT
      (SELECT count(*) FROM construction.daily_reports WHERE project_id = :p)::int AS rdos,
      (SELECT count(*) FROM construction.daily_materials m JOIN construction.daily_reports r ON r.id = m.daily_report_id WHERE r.project_id = :p)::int AS materiais`, { p: project.id }));
  try {
    await assert.rejects(() => H.comCommit(tenant, (t) => H.svc('dailyReports').createDailyReport(project.id, rdo, tenant.userId, t)));
  } finally {
    queda.restaurar();
  }
  assert.ok(queda.estado.derrubou);
  assert.deepEqual(queda.estado.antes, { rdos: 1, materiais: 2 }, 'a queda foi no meio: RDO e materiais já gravados na transação');
  const [sobra] = await H.linhaAdmin(`SELECT (SELECT count(*) FROM construction.daily_reports WHERE project_id = $1)::int AS rdos,
    (SELECT count(*) FROM construction.daily_materials m JOIN construction.daily_reports r ON r.id = m.daily_report_id WHERE r.project_id = $1)::int AS materiais,
    (SELECT count(*) FROM integration.outbox_events WHERE event_type = 'project.daily_log.created' AND payload_json->>'projectId' = $1::text)::int AS eventos`, [project.id]);
  assert.deepEqual(sobra, { rdos: 0, materiais: 0, eventos: 0 });
  const criado = await H.comCommit(tenant, (t) => H.svc('dailyReports').createDailyReport(project.id, rdo, tenant.userId, t));
  const repetido = await H.comCommit(tenant, (t) => H.svc('dailyReports').createDailyReport(project.id, rdo, tenant.userId, t));
  assert.equal(repetido.id, criado.id, 'o reenvio com a mesma chave devolve o mesmo RDO');
  const [depois] = await H.linhaAdmin('SELECT count(*)::int AS rdos FROM construction.daily_reports WHERE project_id = $1', [project.id]);
  assert.equal(depois.rdos, 1);
});

test('FALHA REAL 4 — conexão cai na decisão do Change Order depois de gravar orçamento, obra e aditivo e antes da auditoria: orçamento, obra e aditivo voltam exatamente ao estado anterior', { skip: pular }, async () => {
  const fx = await H.comCommit(tenant, async (t) => {
    const { project } = await H.obraComEtapa(tenant, t, 'queda no aditivo');
    await H.svc('marginRules').createMarginRule(H.W(tenant, { minMarginPct: 5 }), tenant.userId, t);
    const budget = await H.svc('budgets').createBudget(project.id, H.W(tenant, {}), tenant.userId, t);
    await H.svc('budgetLines').createBudgetLine(project.id, H.W(tenant, { budgetId: budget.id, category: 'Estrutura', plannedAmount: 40000 }), tenant.userId, t);
    await H.svc('budgets').approveBudget(budget.id, tenant.userId, t);
    const foto = await filesService.uploadFile(H.W(tenant, {
      fileName: `aditivo-${H.uniqueSuffix()}.jpg`, mimeType: 'image/jpeg', category: 'CONSTRUCTION_EVIDENCE',
      contentBase64: Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), crypto.randomBytes(32)]).toString('base64'),
    }), tenant.userId, t);
    const co = await H.svc('changeOrders').createChangeOrder(project.id, H.W(tenant, {
      reasonCode: 'ESCOPO_ADICIONAL', description: 'Reforço de fundação', budgetImpact: 3500, scheduleImpactDays: 4, evidenceFileIds: [foto.id], idempotencyKey: `o9-co-${H.uniqueSuffix()}`,
    }), tenant.userId, t);
    return { projectId: project.id, budgetId: budget.id, changeOrderId: co.id };
  });
  const retrato = async () => (await H.linhaAdmin(`SELECT b.status AS orcamento, b.baseline_amount::numeric AS baseline, b.total_amount::numeric AS total, b.lock_version AS lv_orc,
      p.budget_amount::numeric AS obra, p.lock_version AS lv_obra, c.status AS aditivo, c.decided_at IS NOT NULL AS decidido
    FROM construction.budgets b JOIN construction.projects p ON p.id = b.project_id JOIN construction.change_orders c ON c.project_id = p.id
    WHERE b.id = $1 AND c.id = $2`, [fx.budgetId, fx.changeOrderId]))[0];
  const antesDaQueda = await retrato();
  const queda = H.derrubarConexaoAntes(AuditLog, 'create', transacaoNasOpcoes,
    (t) => lerNa(t, 'SELECT status FROM construction.change_orders WHERE id = :id', { id: fx.changeOrderId }));
  try {
    await assert.rejects(() => H.comCommit(tenant, (t) => H.svc('changeOrders').decideChangeOrder(fx.changeOrderId, { decision: 'APPROVE' }, tenant.userId, t)));
  } finally {
    queda.restaurar();
  }
  assert.ok(queda.estado.derrubou);
  assert.equal(queda.estado.antes.status, 'APPROVED', 'a queda foi no meio: a transação já tinha gravado o aditivo aprovado');
  assert.deepEqual(await retrato(), antesDaQueda, 'orçamento, obra e aditivo idênticos ao estado anterior (valores e lock_version)');
  assert.equal((await H.linhaAdmin("SELECT id FROM audit.audit_log WHERE entity_id = $1 AND action LIKE 'construction.change_order%' AND after_json->>'status' = 'APPROVED'", [fx.changeOrderId])).length, 0, 'nenhuma auditoria de aprovação sobreviveu');
});
