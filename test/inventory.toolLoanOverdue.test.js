'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix } = require('./testHelpers');
const { Notification, Task, UserMembership, RolePermission, Permission } = require('../src/models');
const assetsService = require('../src/features/inventory/assets.service');
const toolLoansService = require('../src/features/inventory/toolLoans.service');
const { escalateOverdueToolLoans } = require('../src/engines/jobs/toolLoanOverdueJob');
const { InventoryMaintenanceOrder } = require('../src/models');

let tenant;
const DAY_MS = 24 * 60 * 60 * 1000;
const { businessDateKey } = require('../src/utils/businessDate');

// Revisão Marco 7 (19/10/2026), A3: o empréstimo não aceita mais dueAt no passado. Para testar o
// escalonamento, cria com uma data válida e "faz o tempo passar" regravando due_at direto no
// banco (dentro da transação de rollback do teste).
async function backdateLoan(loan, pastDate, transaction) {
  const dueKey = businessDateKey(pastDate);
  await sequelize.query('UPDATE inventory.tool_loans SET due_at = :d WHERE id = :id', { replacements: { d: dueKey, id: loan.id }, transaction });
  await loan.reload({ transaction });
  return loan;
}

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

    const loan = await backdateLoan(await toolLoansService.loanTool(
      asset.id,
      { conditionOutCode: 'OK', personUserId: tenant.userId, destinationLocationId: (await loanDestination(transaction)).id, dueAt: new Date(Date.now() + 7 * DAY_MS).toISOString() },
      tenant.userId,
      tenant.groupId, tenant.companyId,
      transaction
    ), new Date(Date.now() - 24 * 60 * 60 * 1000), transaction);
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
    await backdateLoan(await toolLoansService.loanTool(
      asset.id,
      { conditionOutCode: 'OK', personUserId: tenant.userId, destinationLocationId: (await loanDestination(transaction)).id, dueAt: new Date(Date.now() + 7 * DAY_MS).toISOString() },
      tenant.userId,
      tenant.groupId, tenant.companyId,
      transaction
    ), new Date(Date.now() - 24 * 60 * 60 * 1000), transaction);

    const first = await escalateOverdueToolLoans(transaction);
    assert.equal(first.escalated, 1);

    const second = await escalateOverdueToolLoans(transaction);
    assert.equal(second.escalated, 0, 'loan já OVERDUE não pode ser escalonado/notificado de novo');
  });
});

// GAP REAL ENCONTRADO (auditoria "Guia do Marcelo" item 14 — Observabilidade — "Teste de
// alerta: provar que alguém recebe e consegue agir", 2026-10-08): os testes acima só provam
// que um registro (Notification/Task) foi gravado no banco. Nenhum teste fechava a cadeia
// completa "notificado -> consegue agir de verdade": (a) a Notification/Task aponta pro
// usuário certo (responsible/personUserId, não um terceiro); (b) esse mesmo usuário tem,
// via RBAC real (role_permissions -> permissions), a permissão exigida pela rota que resolve
// o problema (`inventory:update`, ver inventory.routes.js linha do POST /tool-loans/:id/return);
// (c) chamando o service com esse mesmo ator, o problema realmente se resolve (loan sai de
// OVERDUE pra RETURNED). Sem isso, um bug que apontasse a Notification pro usuário errado, ou
// uma role sem a permissão certa, passaria despercebido mesmo com a Notification "existindo".
test('inventory: o responsável notificado pela ferramenta atrasada realmente tem permissão e consegue agir (returnTool)', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const suffix = uniqueSuffix();
    const asset = await assetsService.createAsset(
      { groupId: tenant.groupId, companyId: tenant.companyId, name: `Lixadeira ${suffix}`, assetTag: `TOOL-${suffix}` },
      tenant.userId,
      transaction
    );

    const loan = await backdateLoan(await toolLoansService.loanTool(
      asset.id,
      { conditionOutCode: 'OK', personUserId: tenant.userId, destinationLocationId: (await loanDestination(transaction)).id, dueAt: new Date(Date.now() + 7 * DAY_MS).toISOString() },
      tenant.userId,
      tenant.groupId, tenant.companyId,
      transaction
    ), new Date(Date.now() - 4 * DAY_MS), transaction);

    const result = await escalateOverdueToolLoans(transaction);
    assert.ok(result.notified >= 1);

    // (a) a Notification e a Task apontam pro MESMO usuário que está com a ferramenta
    // (loan.personUserId) — não pro criador do empréstimo nem pra um administrador qualquer.
    const notification = await Notification.findOne({
      where: { userId: loan.personUserId },
      order: [['created_at', 'DESC']],
      transaction,
    });
    assert.ok(notification, 'Notification precisa existir pro responsável pela ferramenta');

    const task = await Task.findOne({
      where: { relatedEntityType: 'inventory.tool_loans', relatedEntityId: loan.id },
      order: [['created_at', 'DESC']],
      transaction,
    });
    assert.ok(task, 'nível CRITICAL/OVERDUE precisa abrir Task real pro responsável');
    assert.equal(task.assignedToUserId, loan.personUserId, 'Task tem que ser atribuída a quem está de posse da ferramenta, não a outro ator');

    // (b) o usuário notificado tem, via RBAC real (membership -> role -> role_permissions),
    // a permissão exigida pela rota POST /tool-loans/:id/return (`inventory:update`) — provando
    // que não é só um registro solto, o destinatário TEM como agir dentro do próprio sistema.
    const membership = await UserMembership.findOne({
      where: { userId: loan.personUserId, groupId: tenant.groupId, companyId: tenant.companyId, status: 'ACTIVE' },
      transaction,
    });
    assert.ok(membership, 'responsável precisa ter membership ativo na empresa pra ter qualquer permissão');

    const grant = await RolePermission.findOne({
      where: { roleId: membership.roleId },
      include: [{ model: Permission, as: 'permission', where: { code: 'inventory:update' }, required: true }],
      transaction,
    });
    assert.ok(grant, 'role do responsável precisa conceder "inventory:update" — sem isso a rota de devolução nega 403 e a Notification não leva a lugar nenhum');

    // (c) agir de verdade: o MESMO usuário notificado chama o service que a rota expõe, e o
    // problema some (loan deixa de estar atrasado). Fecha o ciclo "recebeu -> consegue agir".
    const { loan: returned } = await toolLoansService.returnTool(
      loan.id,
      { conditionCode: 'OK' },
      loan.personUserId,
      tenant.groupId, tenant.companyId,
      transaction
    );
    assert.equal(returned.status, 'RETURNED', 'o responsável notificado precisa conseguir resolver o próprio alerta via returnTool');
  });
});

// ACHADO REAL (revalidação Claude Browser, Marco 7, 14/10/2026, N2): "due_at" era DATE
// (timestamptz) — uma data pura mandada pelo front ("2026-10-01") virava meia-noite UTC, e ao
// reler/exibir no fuso local (America/Bahia, UTC-3) aparecia como o dia ANTERIOR ("2026-09-30").
// Corrigido trocando a coluna pra DATEONLY (migration 20260101000362), que nunca sofre
// conversão de fuso. Este teste prova ida-e-volta exata, sem depender de nenhum fuso específico
// da máquina que roda o teste.
test('inventory: dueAt do empréstimo nunca perde um dia por conversão de fuso (N2)', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const suffix = uniqueSuffix();
    const asset = await assetsService.createAsset(
      { groupId: tenant.groupId, companyId: tenant.companyId, name: `Serrote ${suffix}`, assetTag: `TOOL-${suffix}` },
      tenant.userId,
      transaction
    );

    const futureDateKey = businessDateKey(new Date(Date.now() + 10 * DAY_MS));
    const loan = await toolLoansService.loanTool(
      asset.id,
      { conditionOutCode: 'OK', personUserId: tenant.userId, destinationLocationId: (await loanDestination(transaction)).id, dueAt: futureDateKey },
      tenant.userId,
      tenant.groupId, tenant.companyId,
      transaction
    );
    assert.equal(loan.dueAt, futureDateKey, 'a data prevista precisa ser EXATAMENTE a digitada, sem deslocar um dia');

    await loan.reload({ transaction });
    assert.equal(loan.dueAt, futureDateKey, 'relendo do banco, continua exatamente a mesma data');

    const movements = await assetsService.listAssetMovements(asset.id, tenant.groupId, tenant.companyId, transaction);
    const loanEntry = movements.find((m) => m.movementType === 'LOAN');
    assert.equal(loanEntry.dueAt, futureDateKey, 'a listagem de histórico também precisa manter a data exata');
  });
});

// ACHADO REAL (revalidação Claude Browser, Marco 7, 14/10/2026, N3): o atributo Sequelize deste
// model é "created_at" (a opção `createdAt: 'created_at'` nas options do model RENOMEIA o
// atributo em vez de só mapear a coluna, já que `underscored: true` já cuida do mapeamento) —
// todo código que lia `loan.createdAt` sempre recebia undefined. Corrigido usando
// `loan.created_at` em assets.service.js (histórico) e toolLoans.service.js (mensagem da OS).
test('inventory: data do empréstimo é persistida e aparece no histórico e na OS de manutenção (N3)', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const suffix = uniqueSuffix();
    const asset = await assetsService.createAsset(
      { groupId: tenant.groupId, companyId: tenant.companyId, name: `Plaina ${suffix}`, assetTag: `TOOL-${suffix}` },
      tenant.userId,
      transaction
    );

    const loan = await toolLoansService.loanTool(
      asset.id,
      { conditionOutCode: 'OK', personUserId: tenant.userId, destinationLocationId: (await loanDestination(transaction)).id, dueAt: new Date(Date.now() + 7 * DAY_MS).toISOString() },
      tenant.userId,
      tenant.groupId, tenant.companyId,
      transaction
    );
    assert.ok(loan.created_at, 'o empréstimo precisa ter uma data de criação persistida');

    const movements = await assetsService.listAssetMovements(asset.id, tenant.groupId, tenant.companyId, transaction);
    const loanEntry = movements.find((m) => m.movementType === 'LOAN');
    assert.ok(loanEntry.movedAt, 'a entrada "Empréstimo" do histórico precisa ter uma data, nunca "—"/undefined');

    const { maintenanceOrder } = await toolLoansService.returnTool(
      loan.id,
      { conditionCode: 'DAMAGED' },
      tenant.userId,
      tenant.groupId, tenant.companyId,
      transaction
    );
    assert.ok(maintenanceOrder, 'devolução danificada precisa abrir uma OS');
    const order = await InventoryMaintenanceOrder.findByPk(maintenanceOrder.id, { transaction });
    assert.doesNotMatch(order.description, /data não registrada/, 'a OS precisa citar a data real do empréstimo, não "data não registrada"');
  });
});
