'use strict';

// Guia do Marcelo do Marco 4, §14 "Eventos mínimos" (fechamento da matriz, 10/11/2026). Os eventos
// de pagamento, recebimento, conciliação, repasse, fechamento e anomalia já têm prova nominal em
// test/m45.cadernoM4Gaps.test.js (M45-M4-01/02) e test/nayaraConferencia1810.finance.test.js (F02-6).
// Este arquivo fecha os dois que faltavam com prova nominal: finance.entry.created e
// finance.commission.created — o evento sai no outbox, na MESMA transação do fato, com o nome
// literal do livro, a chave idempotente do agregado e o payload do fato (sem duplicar no replay).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix, createTestResultCenter, createCommissionSource } = require('./testHelpers');
const financialEntriesService = require('../src/features/finance/financialEntries.service');
const commissionsService = require('../src/features/finance/commissions.service');
const { OutboxEvent, User } = require('../src/models');

let tenant;
before(async () => {
  tenant = await getSeedTenant();
});
after(async () => {
  await sequelize.close();
});

test('M4-G§14.1 finance.entry.created: criar um lançamento publica o evento com o nome literal, uma única vez, na mesma transação', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const centro = await createTestResultCenter(tenant, t);
    const chave = `m4-g14-entry-${uniqueSuffix()}`;
    const entry = await financialEntriesService.createFinancialEntry(
      { groupId: tenant.groupId, companyId: tenant.companyId, entryType: 'CREDIT', nature: 'RECEIVABLE', amount: 0.3, description: `Evento G§14.1 ${chave}`, resultCenterId: centro.id, idempotencyKey: chave },
      tenant.userId,
      t
    );
    const eventos = await OutboxEvent.findAll({ where: { aggregateId: entry.id, eventType: 'finance.entry.created' }, transaction: t });
    assert.equal(eventos.length, 1, 'exatamente um evento finance.entry.created para o lançamento');
    const ev = eventos[0];
    assert.equal(ev.idempotencyKey, `finance.entry.created:${entry.id}`);
    assert.equal(ev.companyId, tenant.companyId);
    const payload = ev.payloadJson || ev.payload;
    assert.equal(payload.id, entry.id);
    assert.equal(payload.nature, 'RECEIVABLE');
    assert.equal(String(payload.amount), '0.30');

    // Replay da criação com a mesma chave do cliente: não nasce lançamento nem evento novo.
    await assert.rejects(() => sequelize.transaction({ transaction: t }, () => financialEntriesService.createFinancialEntry(
      { groupId: tenant.groupId, companyId: tenant.companyId, entryType: 'CREDIT', nature: 'RECEIVABLE', amount: 0.3, description: `Evento G§14.1 ${chave}`, resultCenterId: centro.id, idempotencyKey: chave },
      tenant.userId,
      t
    )));
    const [[{ n }]] = await sequelize.query("SELECT count(*)::int AS n FROM integration.outbox_events WHERE event_type = 'finance.entry.created' AND aggregate_id = :id", { replacements: { id: entry.id }, transaction: t });
    assert.equal(n, 1, 'o replay não publica um segundo evento');
  });
});

test('M4-G§14.9 finance.commission.created: a comissão nascida do fato gerador recebido publica o evento com o nome literal e a versão da regra fica gravada', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const [beneficiario] = await User.findOrCreate({
      where: { email: `m4-g14-comissao-${uniqueSuffix()}@nayaraone.dev` },
      defaults: { name: 'Beneficiário G§14.9', passwordHash: 'x', status: 'ACTIVE' },
      transaction: t,
    });
    const fonte = await createCommissionSource(tenant, t, { baseAmount: 1000, percentage: 5 });
    const { commission } = await commissionsService.createCommission(
      { groupId: tenant.groupId, companyId: tenant.companyId, beneficiaryUserId: beneficiario.id, ...fonte, idempotencyKey: `m4-g14-comm-${uniqueSuffix()}` },
      tenant.userId,
      t
    );
    assert.ok(commission.ruleVersionId, 'a comissão guarda o rule_version_id usado no cálculo');
    const eventos = await OutboxEvent.findAll({ where: { aggregateId: commission.id, eventType: 'finance.commission.created' }, transaction: t });
    assert.equal(eventos.length, 1, 'exatamente um evento finance.commission.created');
    assert.equal(eventos[0].idempotencyKey, `finance.commission.created:${commission.id}`);
    const payload = eventos[0].payloadJson || eventos[0].payload;
    assert.equal(payload.id, commission.id);
    assert.equal(payload.beneficiaryUserId, beneficiario.id);
    assert.equal(Number(payload.totalAmount), 50, '5% de R$ 1.000,00 recebidos');
  });
});
