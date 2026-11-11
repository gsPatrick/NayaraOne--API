'use strict';

/**
 * Fechamento do Marco 5 — Locação, segunda onda: obrigações com periodicidade em legal.lease_obligations (Caderno §4 e
 * §12) e garantia vencendo que gera TAREFA além do evento (Caderno §9). Camada de serviço em transação desfeita no fim.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix } = require('./testHelpers');
const utilitiesService = require('../src/features/billing/utilities.service');
const guaranteesService = require('../src/features/legal/guarantees.service');
const { upsertSetting } = require('../src/features/settings/settings.service');
const { nextDueDate } = require('../src/features/billing/leaseObligationSchedule');
const job = require('../src/engines/jobs/legalGuaranteeExpiryAlertJob');
const { Contract, Task, OutboxEvent } = require('../src/models');
const { completeInsurance } = require('./m5fech.locacao.helpers');

let tenant;
before(async () => { tenant = await getSeedTenant(); });
after(async () => { await sequelize.close(); });

const base = () => ({ groupId: tenant.groupId, companyId: tenant.companyId });

async function contract(t) {
  return Contract.create({ ...base(), contractType: 'LEASE', contractNumber: `M5FO-${uniqueSuffix()}`, status: 'ACTIVE', createdBy: tenant.userId }, { transaction: t });
}

test('fechamento M5 §4/§12: obrigação em legal.lease_obligations com responsável, periodicidade, comprovante e status; padrão de periodicidade por tipo configurável', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const ct = await contract(t);
    const { obligation: agua } = await utilitiesService.createUtilityObligation({ ...base(), contractId: ct.id, utilityType: 'WATER', responsibleParty: 'TENANT', periodicity: 'bimonthly', dueDay: 15 }, tenant.userId, t);
    const { obligation: iptu } = await utilitiesService.createUtilityObligation({ ...base(), contractId: ct.id, utilityType: 'IPTU', responsibleParty: 'LANDLORD' }, tenant.userId, t);
    await upsertSetting('locacao.obrigacoes.periodicidade.GAS', 'QUARTERLY', base(), tenant.userId, t);
    const { obligation: gas } = await utilitiesService.createUtilityObligation({ ...base(), contractId: ct.id, utilityType: 'GAS', responsibleParty: 'TENANT' }, tenant.userId, t);
    assert.deepEqual([agua.periodicity, agua.dueDay, iptu.periodicity, gas.periodicity], ['BIMONTHLY', 15, 'ANNUAL', 'QUARTERLY']);
    await assert.rejects(utilitiesService.createUtilityObligation({ ...base(), contractId: ct.id, utilityType: 'WATER', responsibleParty: 'TENANT', periodicity: 'DIARIA' }, tenant.userId, t), (e) => e.code === 'UTILITY_OBLIGATION_VALIDATION');
    await assert.rejects(utilitiesService.createUtilityObligation({ ...base(), contractId: ct.id, utilityType: 'WATER', responsibleParty: 'TENANT', dueDay: 32 }, tenant.userId, t), (e) => e.code === 'UTILITY_OBLIGATION_VALIDATION');
    const [rows] = await sequelize.query('SELECT id, periodicity, due_day, responsible_party, status FROM legal.lease_obligations WHERE contract_id = :c', { replacements: { c: ct.id }, transaction: t });
    assert.equal(rows.length, 3, 'a tabela do livro guarda as obrigações');
    const [viewRows] = await sequelize.query('SELECT count(*)::int AS n FROM finance.utility_obligations WHERE contract_id = :c', { replacements: { c: ct.id }, transaction: t });
    assert.equal(viewRows[0].n, 3, 'o nome do bloco de cobrança continua resolvendo (visão)');
    assert.deepEqual([nextDueDate('2026-01-31', 'MONTHLY', null), nextDueDate('2026-11-12', 'MONTHLY', 20), nextDueDate('2026-11-12', 'ONE_TIME', null)], ['2026-02-28', '2026-11-20', '2026-11-12']);
  });
});

test('fechamento M5 §9: garantia vencendo gera TAREFA (uma por garantia enquanto aberta) além do evento lease.guarantee.expiring', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const ct = await contract(t);
    const em5 = new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10);
    const g = await guaranteesService.createGuarantee(ct.id, await completeInsurance(tenant, t, { endsAt: em5, renewalDueAt: em5 }), tenant.userId, t);
    await job.processGuaranteesInTransaction(t);
    await job.processGuaranteesInTransaction(t);
    const tasks = await Task.findAll({ where: { relatedEntityType: 'legal.guarantees', relatedEntityId: g.id }, transaction: t });
    assert.equal(tasks.length, 1, 'não duplica a tarefa aberta');
    assert.deepEqual([tasks[0].status, tasks[0].assignedToUserId, tasks[0].priority], ['OPEN', tenant.userId, 'HIGH']);
    assert.ok(await OutboxEvent.findOne({ where: { eventType: 'lease.guarantee.expiring', aggregateId: g.id }, transaction: t }));
  });
});
