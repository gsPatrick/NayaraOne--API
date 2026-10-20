'use strict';

const { Asset, InventoryLocation, InventoryLossCase, InventoryToolLoan } = require('../../models');
const AppError = require('../../utils/AppError');
const { registrarAuditoria, registrarTentativaBloqueada } = require('../../engines/audit/auditLog.service');
const { openMaintenanceOrder } = require('./maintenance.service');
const { publishToolLoanCreated, publishToolReturned } = require('./inventoryEvents.service');
const { businessDateKey, startOfBusinessDay } = require('../../utils/businessDate');

const CONDITION_CODES = ['OK', 'DAMAGED'];

// Revisão Marco 7 (19/10/2026), A3 — EST-006 ("Saída de ferramenta registra responsável, destino,
// DATA PREVISTA DE RETORNO e condição") e §8 "Ferramenta atrasada gera tarefa/escalonamento":
// dueAt era opcional — sem ele o empréstimo nunca fica atrasado e nunca escalona. Agora é
// obrigatório, precisa ser uma data válida de hoje em diante e no máximo TOOL_LOAN_MAX_DAYS adiante. O
// Caderno não fixa o limite; escolhemos 90 dias (o mais conservador que ainda cobre uma etapa
// longa de obra) — empréstimo mais longo deve ser renovado (devolução + nova saída), o que
// força a conferência física periódica da ferramenta.
const TOOL_LOAN_MAX_DAYS = 90;

// dueAt é DATA de calendário (coluna DATEONLY): validado no fuso de São Paulo — de hoje (devolução
// no mesmo dia é permitida) até hoje + TOOL_LOAN_MAX_DAYS. Data pura "AAAA-MM-DD" é usada como
// veio; instante ISO vira a data de calendário de São Paulo (o Front manda meio-dia de SP).
function parseLoanDueAt(dueAt, now = new Date()) {
  if (dueAt == null || dueAt === '') {
    throw AppError.badRequest('Informe a data prevista de devolução da ferramenta.', 'TOOL_LOAN_DUE_AT_INVALID');
  }
  let dateKey = null;
  if (typeof dueAt === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(dueAt)) {
    const probe = new Date(`${dueAt}T12:00:00Z`);
    if (!Number.isNaN(probe.getTime()) && probe.toISOString().slice(0, 10) === dueAt) dateKey = dueAt;
  } else {
    const parsed = new Date(dueAt);
    if (!Number.isNaN(parsed.getTime())) dateKey = businessDateKey(parsed);
  }
  if (!dateKey) {
    throw AppError.badRequest('A data prevista de devolução não é uma data válida.', 'TOOL_LOAN_DUE_AT_INVALID');
  }
  const today = businessDateKey(now);
  const max = businessDateKey(startOfBusinessDay(now, TOOL_LOAN_MAX_DAYS));
  if (dateKey < today) {
    throw AppError.badRequest('A data prevista de devolução não pode estar no passado.', 'TOOL_LOAN_DUE_AT_INVALID');
  }
  if (dateKey > max) {
    throw AppError.badRequest(`A data prevista de devolução pode ser no máximo ${TOOL_LOAN_MAX_DAYS} dias a partir de hoje.`, 'TOOL_LOAN_DUE_AT_INVALID');
  }
  return dateKey;
}

// Guia do Marcelo §6/§7: loanTool exige asset AVAILABLE (EST-TS-05: ferramenta já emprestada
// não pode sair de novo); returnTool exige condition_code e abre manutenção se DAMAGED.
async function loanTool(assetId, payload, actorUserId, groupId, companyId, transaction) {
  const { personUserId, destinationLocationId, dueAt, conditionOutCode } = payload;
  // GAP REAL CORRIGIDO (auditoria real Nayara, Marco 7, 2026-10-14, achado F11): EST-006 pede
  // responsável, destino, data prevista de retorno E condição na saída — só os 3 primeiros eram
  // exigidos. Condição é opcional na API (nem toda ferramenta tem inspeção formal de saída), mas
  // quando informada precisa ser um dos códigos válidos — mesma validação do retorno.
  // Revisão Marco 7 (20/10/2026), M7-F04 — EST-006 exige a condição na saída: obrigatória e válida.
  if (conditionOutCode && !CONDITION_CODES.includes(conditionOutCode)) {
    throw AppError.badRequest(`A condição informada não é válida — escolha uma de: ${CONDITION_CODES.join(', ')}.`, 'TOOL_LOAN_VALIDATION');
  }
  if (!personUserId) {
    throw AppError.badRequest('O responsável pela saída é obrigatório.', 'TOOL_LOAN_VALIDATION');
  }
  // GAP REAL CORRIGIDO (auditoria de conformidade contratual Marco 7, 2026-10-07): EST-006 —
  // "Saída de ferramenta registra responsável, destino, data prevista de retorno e condição" —
  // mas o destino era opcional aqui e a tela nem tinha o campo: empréstimos saíam sem destino
  // registrado e asset.currentLocationId ficava apontando pro almoxarifado de origem (EST-014).
  if (!destinationLocationId) {
    throw AppError.badRequest('O local de destino da ferramenta é obrigatório.', 'TOOL_LOAN_VALIDATION');
  }
  const parsedDueAt = parseLoanDueAt(dueAt);
  if (!conditionOutCode) {
    throw AppError.badRequest('A condição da ferramenta na saída é obrigatória.', 'TOOL_LOAN_VALIDATION');
  }
  const destination = await InventoryLocation.findOne({ where: { id: destinationLocationId, groupId, companyId }, transaction });
  if (!destination) {
    throw AppError.notFound('Local de destino não encontrado.', 'INVENTORY_LOCATION_NOT_FOUND');
  }

  const asset = await Asset.findOne({ where: { id: assetId, groupId, companyId }, transaction, lock: transaction.LOCK.UPDATE });
  if (!asset) throw AppError.notFound('Patrimônio não encontrado.', 'ASSET_NOT_FOUND');
  if (asset.status !== 'AVAILABLE') {
    throw AppError.badRequest('Esta ferramenta não está disponível para empréstimo no momento (já emprestada, em manutenção ou indisponível).', 'TOOL_LOAN_ASSET_UNAVAILABLE');
  }
  // GAP REAL CORRIGIDO (auditoria Marco 7, 2026-10-08): mesmo padrão de guarda que disposeAsset
  // já usa pra bloquear baixa com loss case aberto — um asset com InventoryLossCase OPEN está em
  // apuração de perda/extravio; emprestá-lo de novo antes da decisão humana contradiria o
  // próprio caso em andamento (o item "perdido" sairia de novo pra campo).
  // Revisão Marco 7 (19/10/2026), A5: PENDING_APPROVAL (caso acima da alçada) também é caso não
  // decidido — antes só OPEN bloqueava.
  const openLossCase = await InventoryLossCase.findOne({ where: { assetId, groupId, companyId, status: ['OPEN', 'PENDING_APPROVAL'] }, transaction });
  if (openLossCase) {
    await registrarTentativaBloqueada(
      {
        groupId,
        companyId,
        actorUserId,
        action: 'inventory.tool_loan.loan',
        entityType: 'Asset',
        entityId: asset.id,
        beforeJson: { asset: asset.toJSON(), openLossCase: openLossCase.toJSON() },
        reason: 'Tentativa de emprestar patrimônio com caso de perda OPEN.',
      },
      transaction
    );
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
      dueAt: parsedDueAt,
      conditionOutCode: conditionOutCode || null,
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
    { groupId: asset.groupId, companyId: asset.companyId, actorUserId, action: 'TOOL_LOAN_CREATED', entityType: 'InventoryToolLoan', entityId: loan.id,
      afterJson: { ...loan.toJSON(), assetStatus: asset.status, assetAssignedToUserId: asset.assignedToUserId, assetCurrentLocationId: asset.currentLocationId },
      reason: 'Empréstimo de ferramenta registrado.' },
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

  const auditBefore = { status: loan.status, returnedAt: loan.returnedAt, conditionCode: loan.conditionCode, personUserId: loan.personUserId, destinationLocationId: loan.destinationLocationId };
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
    await registrarTentativaBloqueada(
      {
        groupId,
        companyId,
        actorUserId,
        action: 'inventory.tool_loan.return',
        entityType: 'InventoryToolLoan',
        entityId: loan.id,
        beforeJson: { loan: loan.toJSON(), asset: asset.toJSON() },
        reason: 'Tentativa de devolver empréstimo de patrimônio declarado perdido/extraviado (LOST).',
      },
      transaction
    );
    throw AppError.conflict('Patrimônio declarado perdido/extraviado — não pode ser devolvido como se estivesse em circulação.', 'TOOL_LOAN_ASSET_LOST');
  }
  Object.assign(auditBefore, { assetStatus: asset.status, assetAssignedToUserId: asset.assignedToUserId, assetCurrentLocationId: asset.currentLocationId });
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
        description: `Devolução danificada — ${asset.name || 'ferramenta'} (empréstimo de ${loan.created_at ? new Date(loan.created_at).toLocaleDateString('pt-BR') : 'data não registrada'}).`,
      },
      actorUserId,
      transaction
    );
  }

  await publishToolReturned(loan, transaction);

  await registrarAuditoria(
    { groupId: loan.groupId, companyId: loan.companyId, actorUserId, action: 'TOOL_LOAN_RETURNED', entityType: 'InventoryToolLoan', entityId: loan.id,
      beforeJson: auditBefore,
      afterJson: {
        status: loan.status,
        returnedAt: loan.returnedAt,
        conditionCode: loan.conditionCode,
        personUserId: loan.personUserId,
        assetStatus: asset.status,
        assetAssignedToUserId: asset.assignedToUserId,
        assetCurrentLocationId: asset.currentLocationId,
        maintenanceOrderId: maintenanceOrder ? maintenanceOrder.id : 'Sem manutenção aberta',
      },
      reason: `Ferramenta devolvida (condição: ${conditionCode}).` },
    transaction
  );

  return { loan, maintenanceOrder };
}

async function listToolLoans(groupId, companyId, transaction, { status, assetId } = {}) {
  const where = { groupId, companyId };
  if (status) where.status = status;
  if (assetId) where.assetId = assetId;
  return InventoryToolLoan.findAll({ where, order: [['created_at', 'DESC']], limit: 1500, transaction });
}

module.exports = { CONDITION_CODES, TOOL_LOAN_MAX_DAYS, loanTool, returnTool, listToolLoans };
