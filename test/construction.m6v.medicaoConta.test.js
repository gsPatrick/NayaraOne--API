'use strict';

// Verificação independente do Marco 6:
//  - M6-21 (Guia §6 "approveMeasurement(): lockForUpdate → REVIEWED → evidências → permissão → APPROVED → outbox
//    measurement.approved. Financeiro usa sourceEventId UNIQUE"; Caderno §7): a medição tem evidência (arquivo real da
//    empresa, examinado pelo antivírus), a aprovação confere a evidência (e o mínimo configurado), e a conta a pagar nasce
//    do consumidor do Financeiro para measurement.approved, com source_event_id; reentregar o evento não cria segunda
//    conta; nenhuma medição PAYABLE fica sem conta.
//  - M6-97: a baixa parcial de conta de Obras carrega a obra; painel e drill-down contam o pago sem dobrar.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./testHelpers');
const { W, projectWithApprovedBudget, evidenceIds } = require('./constructionM6vFixture');
const { FinancialEntry, OutboxEvent, StageMeasurement, File, sequelize } = require('../src/models');
const measurementsService = require('../src/features/construction/stageMeasurements.service');
const projectHealthService = require('../src/features/construction/projectHealth.service');
const dashboardService = require('../src/features/construction/dashboard.service');
const settingsService = require('../src/features/settings/settings.service');
const { runEventConsumers } = require('../src/engines/events/consumers');
const receipt = require('../src/modules/finance/application/services/receipt.service');

let tenant;
before(async () => {
  tenant = await H.getSeedTenant();
});
after(async () => {
  await H.sequelize.close();
});

async function medicaoRevisada(t, stage, { valor = 10000, evidenceFileIds } = {}) {
  const m = await measurementsService.createStageMeasurement(stage.id, W(tenant, { measuredPct: 50, measuredAt: '2026-11-09', evidenceFileIds, items: [{ description: 'Sapatas', quantity: 1, unitPrice: valor }] }), tenant.userId, t);
  await measurementsService.submitStageMeasurement(m.id, tenant.userId, t);
  return measurementsService.reviewStageMeasurement(m.id, { notes: 'conferida' }, tenant.userId, t);
}

test('M6-21: medição só aceita evidência real da empresa, examinada pelo antivírus; revisão não sobrescreve a evidência', async () => {
  await H.withRollbackTenantTransaction(tenant, async (t) => {
    const { stage } = await projectWithApprovedBudget(tenant, t);
    await assert.rejects(medicaoRevisada(t, stage, { evidenceFileIds: ['99999999-9999-4999-8999-999999999999'] }), { code: 'CONSTRUCTION_EVIDENCE_FILE_NOT_FOUND' });
    const [semExame] = await evidenceIds(tenant, t);
    await File.update({ scanStatus: null }, { where: { id: semExame }, transaction: t });
    await assert.rejects(medicaoRevisada(t, stage, { evidenceFileIds: [semExame] }), { code: 'CONSTRUCTION_EVIDENCE_FILE_NOT_SCANNED' });
    const foto = await evidenceIds(tenant, t, 2);
    const m = await medicaoRevisada(t, stage, { evidenceFileIds: foto });
    assert.deepEqual([...m.evidenceFileIds].sort(), [...foto].sort());
    const nova = await evidenceIds(tenant, t, 1);
    const rev = await measurementsService.reviseStageMeasurement(m.id, { evidenceFileIds: nova }, tenant.userId, t);
    assert.deepEqual(rev.evidenceFileIds, nova);
    const original = await StageMeasurement.findByPk(m.id, { transaction: t });
    assert.equal(original.status, 'SUPERSEDED');
    assert.deepEqual([...original.evidenceFileIds].sort(), [...foto].sort(), 'a original guarda as evidências dela');
  });
});

test('M6-21: aprovação confere a evidência (mínimo configurado e arquivo ainda válido)', async () => {
  await H.withRollbackTenantTransaction(tenant, async (t) => {
    const { stage } = await projectWithApprovedBudget(tenant, t);
    await settingsService.upsertSetting('construction.medicao.evidencias_minimas', 1, W(tenant), tenant.userId, t, { permissions: ['construction:approve', 'settings:update'] });
    const sem = await medicaoRevisada(t, stage);
    await assert.rejects(measurementsService.decideStageMeasurement(sem.id, { decision: 'APPROVED' }, tenant.userId, t), { code: 'STAGE_MEASUREMENT_EVIDENCE_REQUIRED' });
    const [foto] = await evidenceIds(tenant, t);
    const com = await medicaoRevisada(t, stage, { evidenceFileIds: [foto] });
    // O arquivo some (excluído) entre a revisão e a aprovação: a aprovação confere de novo e recusa.
    await File.destroy({ where: { id: foto }, transaction: t });
    await assert.rejects(measurementsService.decideStageMeasurement(com.id, { decision: 'APPROVED' }, tenant.userId, t), { code: 'CONSTRUCTION_EVIDENCE_FILE_NOT_FOUND' });
    assert.equal((await StageMeasurement.findByPk(com.id, { transaction: t })).status, 'REVIEWED');
  });
});

test('M6-21: a conta a pagar nasce do consumidor do Financeiro para measurement.approved, com source_event_id; reentrega não duplica', async () => {
  await H.withRollbackTenantTransaction(tenant, async (t) => {
    const { project, stage } = await projectWithApprovedBudget(tenant, t);
    const m = await medicaoRevisada(t, stage, { valor: 12345.67, evidenceFileIds: await evidenceIds(tenant, t) });
    const aprovada = await measurementsService.decideStageMeasurement(m.id, { decision: 'APPROVED' }, tenant.userId, t);
    assert.equal(aprovada.status, 'PAYABLE');
    const evento = await OutboxEvent.findOne({ where: { eventType: 'measurement.approved', aggregateId: m.id }, transaction: t });
    assert.ok(evento, 'measurement.approved no outbox');
    assert.equal(evento.payloadJson.projectId, project.id);
    const conta = await FinancialEntry.findByPk(aprovada.payableFinancialEntryId, { transaction: t });
    assert.equal(conta.sourceEventId, evento.id, 'conta criada a partir do evento');
    assert.equal(Number(conta.amount), 12345.67);
    assert.equal(conta.constructionProjectId, project.id);
    assert.equal(conta.nature, 'PAYABLE');

    // O despachante entrega o MESMO evento a todos os consumidores: o do Financeiro não cria outra conta.
    await runEventConsumers(evento, t);
    await runEventConsumers(evento, t);
    assert.equal(await FinancialEntry.count({ where: { sourceEventId: evento.id }, transaction: t }), 1);
    assert.equal(await FinancialEntry.count({ where: { idempotencyKey: `measurement.payable:${m.id}` }, transaction: t }), 1);
    // Aprovar de novo é recusado (a medição já saiu de REVIEWED).
    await assert.rejects(measurementsService.decideStageMeasurement(m.id, { decision: 'APPROVED' }, tenant.userId, t), { code: 'STAGE_MEASUREMENT_INVALID_STATUS' });
    // O banco garante: source_event_id único e nenhuma medição PAYABLE sem conta.
    const [[orfas]] = await sequelize.query("SELECT count(*)::int AS n FROM construction.stage_measurements WHERE status IN ('APPROVED','PAYABLE') AND payable_financial_entry_id IS NULL", { transaction: t });
    assert.equal(orfas.n, 0);
    const erro = await sequelize.transaction({ transaction: t }, (sp) => sequelize.query("UPDATE construction.stage_measurements SET payable_financial_entry_id = NULL WHERE id = :id", { replacements: { id: m.id }, transaction: sp })).then(() => null, (e) => e);
    assert.match(String(erro && erro.message), /stage_measurements_payable_has_entry/);
  });
});

test('M6-97: baixa parcial de conta de Obras carrega a obra; drill-down e painel contam o pago sem dobrar (parcial e quitação)', async () => {
  await H.withRollbackTenantTransaction(tenant, async (t) => {
    const { project, stage } = await projectWithApprovedBudget(tenant, t);
    const m = await medicaoRevisada(t, stage, { valor: 10000, evidenceFileIds: await evidenceIds(tenant, t) });
    const { payableFinancialEntryId: contaId } = await measurementsService.decideStageMeasurement(m.id, { decision: 'APPROVED' }, tenant.userId, t);
    const painelAntes = (await dashboardService.getConstructionDashboard(W(tenant), t)).obras.actualFinancialCostTotal;

    const ms1 = await H.prepareManualSettlement(tenant, contaId, tenant.userId, t);
    await receipt.settleFinancialEntryPartial(contaId, 4000, tenant.userId, t, { manualSettlement: ms1, idempotencyKey: `m6v-p1-${H.uniqueSuffix()}` });
    const filhas = await FinancialEntry.findAll({ where: { parentEntryId: contaId }, transaction: t });
    assert.equal(filhas.length, 1);
    assert.equal(filhas[0].constructionProjectId, project.id, 'a baixa parcial carrega a obra');
    assert.equal(Number((await projectHealthService.getProjectHealth(project.id, t)).actualFinancialCost), 4000);
    const painel1 = (await dashboardService.getConstructionDashboard(W(tenant), t)).obras.actualFinancialCostTotal;
    assert.equal(Math.round((painel1 - painelAntes) * 100) / 100, 4000);

    const ms2 = await H.prepareManualSettlement(tenant, contaId, tenant.userId, t);
    await receipt.settleFinancialEntryPartial(contaId, 6000, tenant.userId, t, { manualSettlement: ms2, idempotencyKey: `m6v-p2-${H.uniqueSuffix()}` });
    assert.equal((await FinancialEntry.findByPk(contaId, { transaction: t })).status, 'SETTLED');
    assert.equal(Number((await projectHealthService.getProjectHealth(project.id, t)).actualFinancialCost), 10000, 'quitada: 10000, não 20000');
    const painel2 = (await dashboardService.getConstructionDashboard(W(tenant), t)).obras.actualFinancialCostTotal;
    assert.equal(Math.round((painel2 - painelAntes) * 100) / 100, 10000);
  });
});
