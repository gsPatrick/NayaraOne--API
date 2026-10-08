'use strict';

const { Asset, InventoryMaintenanceOrder } = require('../../models');
const AppError = require('../../utils/AppError');
const { registrarAuditoria, registrarTentativaBloqueada } = require('../../engines/audit/auditLog.service');
const { publishMaintenanceOpened, publishMaintenanceClosed } = require('./inventoryEvents.service');

// Guia do Marcelo §8/item 7: devolução danificada abre manutenção; OS fecha manualmente e
// libera o asset de volta para AVAILABLE.
//
// BUG REAL CORRIGIDO (auditoria "loop até secar", rodada 14, 2026-10-05): essa função nunca
// travava o `Asset` — o travamento só acontecia em `returnTool` (toolLoans.service.js), que
// seta `asset.status = 'MAINTENANCE'` ANTES de chamar esta função (só como registro histórico
// depois). Mas `POST /inventory/maintenance-orders` expõe esta função direto como endpoint —
// qualquer asset AVAILABLE virava uma OS "OPEN" sem nunca deixar de estar disponível, podendo
// ser emprestado/movimentado normalmente enquanto "em manutenção". Agora trava o asset aqui
// (idempotente — se `returnTool` já deixou MAINTENANCE, é um no-op; se chamado direto num asset
// AVAILABLE, trava de verdade; se o asset já está LOANED, bloqueia — manutenção não pode abrir
// sobre uma ferramenta em uso sem passar pela devolução primeiro).
async function openMaintenanceOrder(payload, actorUserId, transaction) {
  const { groupId, companyId, assetId, sourceToolLoanId, description } = payload;
  if (!groupId || !companyId || !assetId) {
    throw AppError.badRequest('Os campos "groupId", "companyId" e "assetId" são obrigatórios.', 'MAINTENANCE_VALIDATION');
  }

  const asset = await Asset.findOne({ where: { id: assetId, groupId, companyId }, transaction, lock: transaction.LOCK.UPDATE });
  if (!asset) throw AppError.notFound('Patrimônio não encontrado.', 'ASSET_NOT_FOUND');
  if (asset.status === 'LOANED') {
    throw AppError.conflict('Ferramenta emprestada não pode entrar em manutenção — devolva primeiro.', 'MAINTENANCE_ASSET_LOANED');
  }
  // BUG REAL CORRIGIDO (auditoria "loop até secar", rodada 29, 2026-10-05): a guarda era uma
  // blacklist (só bloqueava LOANED) em vez de whitelist — um asset LOST (perda formalmente
  // aprovada via decideLossCase, R28, com evidência obrigatória EST-TS-10) passava direto por
  // aqui e tinha o status sobrescrito pra MAINTENANCE sem nenhum controle, reabrindo o ativo
  // pra circulação (closeMaintenanceOrder libera pra AVAILABLE depois) como se a perda nunca
  // tivesse existido — sem reabrir o loss_case, sem auditoria de "recuperação", sem evidência.
  if (asset.status === 'LOST') {
    await registrarTentativaBloqueada(
      {
        groupId,
        companyId,
        actorUserId,
        action: 'inventory.maintenance_order.open',
        entityType: 'Asset',
        entityId: asset.id,
        beforeJson: asset.toJSON(),
        reason: 'Tentativa de abrir OS de manutenção para patrimônio declarado perdido/extraviado (LOST).',
      },
      transaction
    );
    throw AppError.conflict('Patrimônio declarado perdido/extraviado não pode entrar em manutenção — reverta o caso de perda primeiro.', 'MAINTENANCE_ASSET_LOST');
  }
  // Baixa (venda/descarte/doação — assets.service.js#disposeAsset) é terminal: o patrimônio
  // já saiu da empresa, não pode voltar a circular via manutenção -> AVAILABLE.
  if (asset.status === 'DISPOSED') {
    await registrarTentativaBloqueada(
      {
        groupId,
        companyId,
        actorUserId,
        action: 'inventory.maintenance_order.open',
        entityType: 'Asset',
        entityId: asset.id,
        beforeJson: asset.toJSON(),
        reason: 'Tentativa de abrir OS de manutenção para patrimônio baixado (DISPOSED).',
      },
      transaction
    );
    throw AppError.conflict('Patrimônio baixado (venda/descarte/doação) não pode entrar em manutenção.', 'MAINTENANCE_ASSET_DISPOSED');
  }
  if (asset.status !== 'MAINTENANCE') {
    asset.status = 'MAINTENANCE';
    asset.updatedBy = actorUserId || null;
    await asset.save({ transaction });
  } else {
    // BUG REAL CORRIGIDO (auditoria "loop até secar", rodada 23, 2026-10-05): tratar
    // `asset.status === 'MAINTENANCE'` como simples "já travado, no-op" não bastava — nada
    // impedia abrir uma SEGUNDA OS `OPEN` sobre o mesmo asset (sem UNIQUE no banco pra isso).
    // Fechar uma das duas liberava o asset incondicionalmente (linha ~81 abaixo), deixando a
    // outra OS "esquecida" aberta enquanto o patrimônio já circulava como AVAILABLE de novo.
    // Invariante correta: 1 asset : no máximo 1 OS OPEN por vez.
    const existingOpenOrder = await InventoryMaintenanceOrder.findOne({ where: { assetId, status: 'OPEN' }, transaction });
    if (existingOpenOrder) {
      await registrarTentativaBloqueada(
        {
          groupId,
          companyId,
          actorUserId,
          action: 'inventory.maintenance_order.open',
          entityType: 'Asset',
          entityId: asset.id,
          beforeJson: { asset: asset.toJSON(), existingOpenOrder: existingOpenOrder.toJSON() },
          reason: 'Tentativa de abrir uma segunda OS de manutenção OPEN para o mesmo patrimônio.',
        },
        transaction
      );
      throw AppError.conflict('Já existe uma ordem de manutenção OPEN para este patrimônio — feche-a antes de abrir outra.', 'MAINTENANCE_ORDER_ALREADY_OPEN');
    }
  }

  const order = await InventoryMaintenanceOrder.create(
    {
      groupId,
      companyId,
      assetId,
      sourceToolLoanId: sourceToolLoanId || null,
      description: description || null,
      status: 'OPEN',
      openedAt: new Date(),
      createdBy: actorUserId || null,
      updatedBy: actorUserId || null,
    },
    { transaction }
  );

  await publishMaintenanceOpened(order, transaction);

  await registrarAuditoria(
    { groupId, companyId, actorUserId, action: 'MAINTENANCE_ORDER_OPENED', entityType: 'InventoryMaintenanceOrder', entityId: order.id, reason: 'Ordem de manutenção aberta.' },
    transaction
  );

  return order;
}

async function listMaintenanceOrders(groupId, companyId, transaction, { status, assetId } = {}) {
  const where = { groupId, companyId };
  if (status) where.status = status;
  if (assetId) where.assetId = assetId;
  return InventoryMaintenanceOrder.findAll({ where, order: [['opened_at', 'DESC']], transaction });
}

async function closeMaintenanceOrder(orderId, groupId, companyId, actorUserId, transaction) {
  const order = await InventoryMaintenanceOrder.findOne({ where: { id: orderId, groupId, companyId }, transaction, lock: transaction.LOCK.UPDATE });
  if (!order) throw AppError.notFound('Ordem de manutenção não encontrada.', 'MAINTENANCE_NOT_FOUND');
  if (order.status !== 'OPEN') {
    throw AppError.badRequest(`Só é possível fechar uma OS em OPEN (atual: ${order.status}).`, 'MAINTENANCE_INVALID_TRANSITION');
  }

  order.status = 'CLOSED';
  order.closedAt = new Date();
  order.updatedBy = actorUserId || null;
  await order.save({ transaction });

  const asset = await Asset.findOne({ where: { id: order.assetId, groupId, companyId }, transaction, lock: transaction.LOCK.UPDATE });
  if (asset && asset.status === 'MAINTENANCE') {
    // BUG REAL CORRIGIDO (rodada 23): liberar o asset incondicionalmente ao fechar QUALQUER OS
    // ignorava a possibilidade de existir outra OS ainda OPEN pro mesmo asset — agora só libera
    // se não restar nenhuma outra. A busca roda DEPOIS do `order.save` acima (já marcado CLOSED)
    // pra não contar a própria OS que está sendo fechada.
    const remainingOpenOrder = await InventoryMaintenanceOrder.findOne({ where: { assetId: order.assetId, status: 'OPEN' }, transaction });
    if (!remainingOpenOrder) {
      asset.status = 'AVAILABLE';
      asset.updatedBy = actorUserId || null;
      await asset.save({ transaction });
    }
  }

  await publishMaintenanceClosed(order, transaction);

  await registrarAuditoria(
    { groupId: order.groupId, companyId: order.companyId, actorUserId, action: 'MAINTENANCE_ORDER_CLOSED', entityType: 'InventoryMaintenanceOrder', entityId: order.id, reason: 'Ordem de manutenção fechada — patrimônio liberado.' },
    transaction
  );

  return order;
}

module.exports = { openMaintenanceOrder, listMaintenanceOrders, closeMaintenanceOrder };
