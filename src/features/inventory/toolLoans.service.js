'use strict';

const { Asset, InventoryToolLoan } = require('../../models');
const AppError = require('../../utils/AppError');
const { registrarAuditoria } = require('../../engines/audit/auditLog.service');
const { openMaintenanceOrder } = require('./maintenance.service');
const { publishToolLoanCreated, publishToolReturned } = require('./inventoryEvents.service');

const CONDITION_CODES = ['OK', 'DAMAGED'];

// Guia do Marcelo §6/§7: loanTool exige asset AVAILABLE (EST-TS-05: ferramenta já emprestada
// não pode sair de novo); returnTool exige condition_code e abre manutenção se DAMAGED.
async function loanTool(assetId, payload, actorUserId, transaction) {
  const { personUserId, destinationLocationId, dueAt } = payload;
  if (!personUserId) {
    throw AppError.badRequest('"personUserId" é obrigatório (EST-006: responsável pela saída).', 'TOOL_LOAN_VALIDATION');
  }

  const asset = await Asset.findByPk(assetId, { transaction, lock: transaction.LOCK.UPDATE });
  if (!asset) throw AppError.notFound('Patrimônio não encontrado.', 'ASSET_NOT_FOUND');
  if (asset.status !== 'AVAILABLE') {
    throw AppError.badRequest(`Ferramenta indisponível para empréstimo (status atual: ${asset.status}) — EST-TS-05.`, 'TOOL_LOAN_ASSET_UNAVAILABLE');
  }

  const loan = await InventoryToolLoan.create(
    {
      groupId: asset.groupId,
      companyId: asset.companyId,
      assetId: asset.id,
      personUserId,
      destinationLocationId: destinationLocationId || null,
      dueAt: dueAt || null,
      status: 'OPEN',
      createdBy: actorUserId || null,
      updatedBy: actorUserId || null,
    },
    { transaction }
  );

  asset.status = 'LOANED';
  asset.assignedToUserId = personUserId;
  asset.updatedBy = actorUserId || null;
  await asset.save({ transaction });

  await publishToolLoanCreated(loan, transaction);

  await registrarAuditoria(
    { groupId: asset.groupId, companyId: asset.companyId, actorUserId, action: 'TOOL_LOAN_CREATED', entityType: 'InventoryToolLoan', entityId: loan.id, reason: 'Empréstimo de ferramenta registrado.' },
    transaction
  );

  return loan;
}

async function returnTool(loanId, payload, actorUserId, transaction) {
  const { conditionCode } = payload;
  if (!conditionCode || !CONDITION_CODES.includes(conditionCode)) {
    throw AppError.badRequest(`"conditionCode" precisa ser um de: ${CONDITION_CODES.join(', ')}.`, 'TOOL_LOAN_VALIDATION');
  }

  const loan = await InventoryToolLoan.findByPk(loanId, { transaction, lock: transaction.LOCK.UPDATE });
  if (!loan) throw AppError.notFound('Empréstimo não encontrado.', 'TOOL_LOAN_NOT_FOUND');
  if (loan.status !== 'OPEN') {
    throw AppError.badRequest(`Só é possível devolver um empréstimo em OPEN (atual: ${loan.status}).`, 'TOOL_LOAN_INVALID_TRANSITION');
  }

  loan.status = 'RETURNED';
  loan.returnedAt = new Date();
  loan.conditionCode = conditionCode;
  loan.updatedBy = actorUserId || null;
  await loan.save({ transaction });

  const asset = await Asset.findByPk(loan.assetId, { transaction, lock: transaction.LOCK.UPDATE });
  asset.status = conditionCode === 'DAMAGED' ? 'MAINTENANCE' : 'AVAILABLE';
  asset.updatedBy = actorUserId || null;
  await asset.save({ transaction });

  let maintenanceOrder = null;
  if (conditionCode === 'DAMAGED') {
    maintenanceOrder = await openMaintenanceOrder(
      {
        groupId: loan.groupId,
        companyId: loan.companyId,
        assetId: asset.id,
        sourceToolLoanId: loan.id,
        description: `Devolução danificada do empréstimo ${loan.id}.`,
      },
      actorUserId,
      transaction
    );
  }

  await publishToolReturned(loan, transaction);

  await registrarAuditoria(
    { groupId: loan.groupId, companyId: loan.companyId, actorUserId, action: 'TOOL_LOAN_RETURNED', entityType: 'InventoryToolLoan', entityId: loan.id, reason: `Ferramenta devolvida (condição: ${conditionCode}).` },
    transaction
  );

  return { loan, maintenanceOrder };
}

async function listToolLoans(transaction, { status, assetId } = {}) {
  const where = {};
  if (status) where.status = status;
  if (assetId) where.assetId = assetId;
  return InventoryToolLoan.findAll({ where, order: [['created_at', 'DESC']], transaction });
}

module.exports = { CONDITION_CODES, loanTool, returnTool, listToolLoans };
