'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix } = require('./testHelpers');
const { Notification } = require('../src/models');
const assetsService = require('../src/features/inventory/assets.service');
const toolLoansService = require('../src/features/inventory/toolLoans.service');
const { escalateOverdueToolLoans } = require('../src/engines/jobs/toolLoanOverdueJob');

let tenant;

before(async () => {
  tenant = await getSeedTenant();
});

after(async () => {
  await sequelize.close();
});

// EST-006: loanTool exige destino da saída (destinationLocationId).
async function loanDestination(transaction) {
  const itemsService = require('../src/features/inventory/items.service');
  return itemsService.createLocation(
    { groupId: tenant.groupId, companyId: tenant.companyId, name: `Destino empréstimo ${uniqueSuffix()}`, locationType: 'WAREHOUSE' },
    tenant.userId,
    transaction
  );
}

// Gap real encontrado em auditoria "loop até secar" (rodada 10, 2026-10-05): o contrato
// (EST-TS-13 "Ferramenta atrasada -> Escalona") esperava um alerta de verdade, mas o job só
// publicava tool.loan.overdue (evento de integração via outbox) e mudava o status — ninguém
// dentro do app era notificado. Mesma lacuna já corrigida nas rodadas 7 e 9.
test('inventory: toolLoanOverdueJob cria Notification real pro responsável quando o empréstimo vence', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const suffix = uniqueSuffix();
    const asset = await assetsService.createAsset(
      { groupId: tenant.groupId, companyId: tenant.companyId, name: `Furadeira ${suffix}`, assetTag: `TOOL-${suffix}` },
      tenant.userId,
      transaction
    );

    const loan = await toolLoansService.loanTool(
      asset.id,
      { personUserId: tenant.userId, destinationLocationId: (await loanDestination(transaction)).id, dueAt: new Date(Date.now() - 24 * 60 * 60 * 1000) },
      tenant.userId,
      tenant.groupId, tenant.companyId,
      transaction
    );
    assert.equal(loan.status, 'OPEN');

    const result = await escalateOverdueToolLoans(transaction);
    assert.ok(result.escalated >= 1);
    assert.ok(result.notified >= 1, 'escalonar pra OVERDUE precisa notificar ao menos um responsável');

    await loan.reload({ transaction });
    assert.equal(loan.status, 'OVERDUE');

    const notification = await Notification.findOne({
      where: { userId: tenant.userId },
      order: [['created_at', 'DESC']],
      transaction,
    });
    assert.ok(notification, 'precisa existir uma Notification real, não só o evento de outbox');
    assert.match(notification.title, /atrasada/i);
  });
});

test('inventory: toolLoanOverdueJob é idempotente — rodar de novo não duplica notificação pro mesmo empréstimo', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const suffix = uniqueSuffix();
    const asset = await assetsService.createAsset(
      { groupId: tenant.groupId, companyId: tenant.companyId, name: `Serra ${suffix}`, assetTag: `TOOL-${suffix}` },
      tenant.userId,
      transaction
    );
    await toolLoansService.loanTool(
      asset.id,
      { personUserId: tenant.userId, destinationLocationId: (await loanDestination(transaction)).id, dueAt: new Date(Date.now() - 24 * 60 * 60 * 1000) },
      tenant.userId,
      tenant.groupId, tenant.companyId,
      transaction
    );

    const first = await escalateOverdueToolLoans(transaction);
    assert.equal(first.escalated, 1);

    const second = await escalateOverdueToolLoans(transaction);
    assert.equal(second.escalated, 0, 'loan já OVERDUE não pode ser escalonado/notificado de novo');
  });
});
