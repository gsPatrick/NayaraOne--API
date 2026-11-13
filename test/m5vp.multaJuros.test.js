'use strict';

/**
 * Fechamento M5 (vistorias e prazos) — M5-A0330, livro (bloco de cobrança) "Multa/juros/grace/cadência via Motor de Regras":
 * o caso de cobrança calcula multa, juros e carência só pela ação da versão vigente de REG-LOC-001/REG-LOC-002 (provado com
 * números diferentes do antigo padrão 2/1/3); gravar o número na configuração publica versão nova da regra; empresa que já
 * tinha número gravado é alinhada na primeira cobrança, com auditoria.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize, getSeedTenant, withRollbackTenantTransaction } = require('./testHelpers');
const contractsService = require('../src/modules/legal/contracts/application/contract.service');
const billingScheduleService = require('../src/features/billing/billingSchedule.service');
const collectionCaseService = require('../src/features/billing/collectionCase.service');
const { seedBillingRules } = require('../scripts/seedBillingRules');
const { gravarParametroSensivel } = require('./helpers/mfaRecente');
const { TenantSetting, Rule, RuleVersion, RuleScope, RulePublication, AuditLog } = require('../src/models');

let tenant;
before(async () => { tenant = await getSeedTenant(); });
after(async () => { await sequelize.close(); });

const base = () => ({ groupId: tenant.groupId, companyId: tenant.companyId });
let periodSeq = 0;

/** Publica versão nova da regra com a ação dada (fecha a vigente), direto no Motor de Regras — sem passar pelo código sob teste. */
async function publishRule(code, patch, t) {
  const rule = await Rule.findOne({ where: { code, ...base() }, transaction: t });
  const vigente = await RuleVersion.findOne({ where: { ruleId: rule.id, status: 'PUBLISHED', effectiveUntil: null }, order: [['versionNumber', 'DESC']], transaction: t });
  const now = new Date();
  await RuleVersion.update({ effectiveUntil: new Date(now.getTime() - 1) }, { where: { ruleId: rule.id, status: 'PUBLISHED', effectiveUntil: null }, transaction: t });
  const last = await RuleVersion.findOne({ where: { ruleId: rule.id }, order: [['versionNumber', 'DESC']], transaction: t });
  const v = await RuleVersion.create({
    ...base(), ruleId: rule.id, versionNumber: last.versionNumber + 1, conditionAstJson: vigente.conditionAstJson, contentHash: vigente.contentHash,
    actionJson: { ...vigente.actionJson, ...patch }, effectiveFrom: now, effectiveUntil: null, status: 'PUBLISHED', publishedByUserId: tenant.userId, createdBy: tenant.userId, updatedBy: tenant.userId,
  }, { transaction: t });
  await RuleScope.create({ ...base(), ruleVersionId: v.id, scopeType: 'GLOBAL', scopeRefId: null, precedence: 7, createdBy: tenant.userId, updatedBy: tenant.userId }, { transaction: t });
  await RulePublication.create({ ...base(), ruleVersionId: v.id, publishedByUserId: tenant.userId, publishedAt: now, createdBy: tenant.userId, updatedBy: tenant.userId }, { transaction: t });
  return v;
}

async function overdueSchedule(t) {
  const contract = await contractsService.createContract({ ...base(), contractType: 'LEASE', totalValue: 3000 }, tenant.userId, t);
  periodSeq += 1;
  const period = `2032-${String(periodSeq).padStart(2, '0')}`;
  return billingScheduleService.generateBillingSchedule({ ...base(), contractId: contract.id, period, dueDate: `${period}-05`, items: [{ componentType: 'RENT', amount: 2000 }] }, tenant.userId, t);
}

test('M5-A0330: multa 7%, juros 3% ao mês e carência 5 dias vêm da regra publicada (não do padrão 2/1/3)', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    await seedBillingRules({ ...base(), userId: tenant.userId }, t);
    await TenantSetting.destroy({ where: { companyId: tenant.companyId, key: ['billing.late_fee_percentage', 'billing.interest_percentage', 'billing.grace_period_days'] }, transaction: t });
    const v1 = await publishRule('REG-LOC-001', { penaltyPercentage: 7, monthlyInterestPercentage: 3 }, t);
    const v2 = await publishRule('REG-LOC-002', { graceDays: 5 }, t);
    const schedule = await overdueSchedule(t);
    await assert.rejects(() => collectionCaseService.openCollectionCase(schedule.id, 4, tenant.userId, t), (err) => err.code === 'COLLECTION_CASE_WITHIN_GRACE_PERIOD');
    const cc = await collectionCaseService.openCollectionCase(schedule.id, 15, tenant.userId, t);
    assert.equal(Number(cc.penaltyAmount), 140, '7% de 2000');
    assert.equal(Number(cc.interestAmount), 20, '3% ao mês, 10 dias além da carência de 5: 2000 * 0,03 * 10/30');
    assert.equal(cc.graceDaysApplied, 5);
    assert.equal(cc.penaltyRuleVersionId, v1.id);
    assert.equal(cc.graceRuleVersionId, v2.id);
  });
});

test('M5-A0330: gravar a multa na configuração (com MFA) publica versão nova da regra, e é ela que o caso usa; número antigo gravado é alinhado com auditoria', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    await seedBillingRules({ ...base(), userId: tenant.userId }, t);
    await publishRule('REG-LOC-001', { penaltyPercentage: 7, monthlyInterestPercentage: 3 }, t);
    await gravarParametroSensivel('billing.late_fee_percentage', 4, tenant, t);
    const published = await AuditLog.findOne({ where: { action: 'billing.penalty_rule.publish', companyId: tenant.companyId }, order: [['created_at', 'DESC']], transaction: t });
    assert.ok(published, 'gravar o número publica versão nova da regra');
    assert.equal(published.afterJson.action.penaltyPercentage, 4);
    assert.equal(published.afterJson.action.monthlyInterestPercentage, 3, 'o resto da ação é preservado');
    const cc = await collectionCaseService.openCollectionCase((await overdueSchedule(t)).id, 15, tenant.userId, t);
    assert.equal(Number(cc.penaltyAmount), 80, '4% de 2000');
    assert.equal(cc.penaltyRuleVersionId, published.entityId);

    // Número gravado antes desta mudança (linha de configuração sem versão da regra correspondente): alinhado na cobrança.
    await TenantSetting.update({ value: 9 }, { where: { companyId: tenant.companyId, key: 'billing.late_fee_percentage' }, transaction: t });
    const cc2 = await collectionCaseService.openCollectionCase((await overdueSchedule(t)).id, 15, tenant.userId, t);
    assert.equal(Number(cc2.penaltyAmount), 180, '9% de 2000');
    const vigente = await RuleVersion.findByPk(cc2.penaltyRuleVersionId, { transaction: t });
    assert.equal(Number(vigente.actionJson.penaltyPercentage), 9);
    assert.equal(vigente.status, 'PUBLISHED');
  });
});
