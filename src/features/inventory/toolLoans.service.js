'use strict';

const { Asset, InventoryLocation, InventoryLossCase, InventoryToolLoan } = require('../../models');
const AppError = require('../../utils/AppError');
const { registrarAuditoria } = require('../../engines/audit/auditLog.service');
const { openMaintenanceOrder } = require('./maintenance.service');
const { publishToolLoanCreated, publishToolReturned } = require('./inventoryEvents.service');

const CONDITION_CODES = ['OK', 'DAMAGED'];

// Guia do Marcelo §6/§7: loanTool exige asset AVAILABLE (EST-TS-05: ferramenta já emprestada
// não pode sair de novo); returnTool exige condition_code e abre manutenção se DAMAGED.
async function loanTool(assetId, payload, actorUserId, groupId, companyId, transaction) {
  const { personUserId, destinationLocationId, dueAt } = payload;
  if (!personUserId) {
    throw AppError.badRequest('"personUserId" é obrigatório (EST-006: responsável pela saída).', 'TOOL_LOAN_VALIDATION');
  }
  // GAP REAL CORRIGIDO (auditoria de conformidade contratual Marco 7, 2026-10-07): EST-006 —
  // "Saída de ferramenta registra responsável, destino, data prevista de retorno e condição" —
  // mas o destino era opcional aqui e a tela nem tinha o campo: empréstimos saíam sem destino
  // registrado e asset.currentLocationId ficava apontando pro almoxarifado de origem (EST-014).
  if (!destinationLocationId) {
    throw AppError.badRequest('"destinationLocationId" é obrigatório (EST-006: destino da saída).', 'TOOL_LOAN_VALIDATION');
  }
  const destination = await InventoryLocation.findOne({ where: { id: destinationLocationId, groupId, companyId }, transaction });
  if (!destination) {
    throw AppError.notFound('Local de destino não encontrado.', 'INVENTORY_LOCATION_NOT_FOUND');
  }

  const asset = await Asset.findOne({ where: { id: assetId, groupId, companyId }, transaction, lock: transaction.LOCK.UPDATE });
  if (!asset) throw AppError.notFound('Patrimônio não encontrado.', 'ASSET_NOT_FOUND');
  if (asset.status !== 'AVAILABLE') {
    throw AppError.badRequest(`Ferramenta indisponível para empréstimo (status atual: ${asset.status}) — EST-TS-05.`, 'TOOL_LOAN_ASSET_UNAVAILABLE');
  }
  // GAP REAL CORRIGIDO (auditoria Marco 7, 2026-10-08): mesmo padrão de guarda que disposeAsset
  // já usa pra bloquear baixa com loss case aberto — um asset com InventoryLossCase OPEN está em
  // apuração de perda/extravio; emprestá-lo de novo antes da decisão humana contradiria o
  // próprio caso em andamento (o item "perdido" sairia de novo pra campo).
  const openLossCase = await InventoryLossCase.findOne({ where: { assetId, status: 'OPEN' }, transaction });
  if (openLossCase) {
    throw AppError.conflict('Existe um caso de perda aberto para este patrimônio — decida-o antes de emprestar.', 'TOOL_LOAN_LOSS_CASE_OPEN');
  }

  // BUG REAL CORRIGIDO (auditoria "loop até secar", rodada 22, 2026-10-05): EST-006 exige que a
  // saída registre o destino, e EST-014 que o Asset tenha localização condizente com a
  // realidade — mas `destinationLocationId` só era gravado no empréstimo, nunca propagado para
  // `asset.currentLocationId`. `sourceLocationId` guarda de onde a ferramenta saiu, pra
  // returnTool poder restaurá-lo depois (mesma classe de bug da R21, campo que não era
  // mantido numa transição, mas em `currentLocationId` em vez de `assignedToUserId`).
  const loan = await InventoryToolLoan.create(
    {
      groupId: asset.groupId,
      companyId: asset.companyId,
      assetId: asset.id,
      personUserId,
      destinationLocationId,
      sourceLocationId: asset.currentLocationId || null,
      dueAt: dueAt || null,
      status: 'OPEN',
      createdBy: actorUserId || null,
      updatedBy: actorUserId || null,
    },
    { transaction }
  );

  asset.status = 'LOANED';
  asset.assignedToUserId = personUserId;
  asset.currentLocationId = destinationLocationId;
  asset.updatedBy = actorUserId || null;
  await asset.save({ transaction });

  await publishToolLoanCreated(loan, transaction);

  await registrarAuditoria(
    { groupId: asset.groupId, companyId: asset.companyId, actorUserId, action: 'TOOL_LOAN_CREATED', entityType: 'InventoryToolLoan', entityId: loan.id, reason: 'Empréstimo de ferramenta registrado.' },
    transaction
  );

  return loan;
}

async function returnTool(loanId, payload, actorUserId, groupId, companyId, transaction) {
  const { conditionCode } = payload;
  if (!conditionCode || !CONDITION_CODES.includes(conditionCode)) {
    throw AppError.badRequest(`"conditionCode" precisa ser um de: ${CONDITION_CODES.join(', ')}.`, 'TOOL_LOAN_VALIDATION');
  }

  const loan = await InventoryToolLoan.findOne({ where: { id: loanId, groupId, companyId }, transaction, lock: transaction.LOCK.UPDATE });
  if (!loan) throw AppError.notFound('Empréstimo não encontrado.', 'TOOL_LOAN_NOT_FOUND');
  // OVERDUE é só um estado de alerta do mesmo empréstimo aberto (ver toolLoanOverdueJob.js) —
  // devolução continua válida depois do vencimento, só não pode repetir sobre um já RETURNED.
  if (!['OPEN', 'OVERDUE'].includes(loan.status)) {
    throw AppError.badRequest(`Só é possível devolver um empréstimo em OPEN/OVERDUE (atual: ${loan.status}).`, 'TOOL_LOAN_INVALID_TRANSITION');
  }

  loan.status = 'RETURNED';
  loan.returnedAt = new Date();
  loan.conditionCode = conditionCode;
  loan.updatedBy = actorUserId || null;
  await loan.save({ transaction });

  const asset = await Asset.findOne({ where: { id: loan.assetId, groupId, companyId }, transaction, lock: transaction.LOCK.UPDATE });
  // Defesa em profundidade (rodada 30): decideLossCase já fecha o loan como 'LOST' ao aprovar
  // a perda do asset (o que já bloqueia este returnTool pela whitelist OPEN/OVERDUE acima), mas
  // esta checagem direta no asset garante que nenhum caminho de dados legado/futuro consiga
  // reverter uma perda formalizada sobrescrevendo o status aqui.
  if (asset.status === 'LOST') {
    throw AppError.conflict('Patrimônio declarado perdido/extraviado — não pode ser devolvido como se estivesse em circulação.', 'TOOL_LOAN_ASSET_LOST');
  }
  asset.status = conditionCode === 'DAMAGED' ? 'MAINTENANCE' : 'AVAILABLE';
  // BUG REAL CORRIGIDO (auditoria "loop até secar", rodada 21, 2026-10-05): devolver a
  // ferramenta nunca limpava `assignedToUserId` (custodiante, EST-014 — "Asset possui
  // aquisição, valor, localização, custodiante, garantia, status e manutenção") — o custodiante
  // ficava "preso" no último tomador mesmo depois da devolução, inclusive durante toda a
  // manutenção subsequente, e corrompia `sourceCustodianUserId` numa transferência futura
  // (assets.service.js#transferAsset lê `asset.assignedToUserId` como "de quem estava saindo").
  asset.assignedToUserId = null;
  if (loan.sourceLocationId) asset.currentLocationId = loan.sourceLocationId;
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

async function listToolLoans(groupId, companyId, transaction, { status, assetId } = {}) {
  const where = { groupId, companyId };
  if (status) where.status = status;
  if (assetId) where.assetId = assetId;
  return InventoryToolLoan.findAll({ where, order: [['created_at', 'DESC']], transaction });
}

module.exports = { CONDITION_CODES, loanTool, returnTool, listToolLoans };
