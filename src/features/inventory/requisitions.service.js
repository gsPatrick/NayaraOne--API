'use strict';

const { InventoryRequisition, InventoryRequisitionItem, InventoryLocation, InventoryItem, ProjectStage, Project, User, Person } = require('../../models');
const AppError = require('../../utils/AppError');
const { registrarAuditoria } = require('../../engines/audit/auditLog.service');
const { recordMovement } = require('./movements.service');
const { publishRequisitionCreated } = require('./inventoryEvents.service');

// Guia do Marcelo §5: Saída para obra — REQUESTED -> APPROVED/REJECTED -> ISSUED (OUT com
// project_id/stage_id — EST-004). "Separação gera reserva opcional" do Caderno não é
// implementada aqui como reserva de saldo (não há tabela de reserva no DoD mínimo); a baixa
// (issue) é o ponto de verdade único de saída de saldo, idêntico ao padrão já usado em receipts.
const STATUSES = ['REQUESTED', 'APPROVED', 'REJECTED', 'ISSUED'];

async function createRequisition(payload, actorUserId, transaction) {
  const { groupId, companyId, warehouseLocationId, projectLocationId } = payload;
  let { projectId, stageId } = payload;
  const { notes, items } = payload;

  if (!groupId || !companyId || !warehouseLocationId || !Array.isArray(items) || items.length === 0) {
    throw AppError.badRequest(
      'Os campos "groupId", "companyId", "warehouseLocationId" e "items" (não vazio) são obrigatórios.',
      'INVENTORY_REQUISITION_VALIDATION'
    );
  }
  // EST-004: material atribuído à obra precisa de project_id/stage_id.
  if (projectId && !projectLocationId) {
    throw AppError.badRequest('Requisição vinculada a obra exige "projectLocationId" (local de destino no canteiro).', 'INVENTORY_REQUISITION_VALIDATION');
  }
  for (const line of items) {
    if (!line.inventoryItemId || line.quantity == null || !Number.isFinite(Number(line.quantity)) || Number(line.quantity) <= 0) {
      throw AppError.badRequest('Cada item precisa de "inventoryItemId" e "quantity" > 0.', 'INVENTORY_REQUISITION_VALIDATION');
    }
  }

  const warehouse = await InventoryLocation.findByPk(warehouseLocationId, { transaction });
  if (!warehouse) throw AppError.notFound('Local de origem (almoxarifado) não encontrado.', 'INVENTORY_LOCATION_NOT_FOUND');

  // GAP REAL CORRIGIDO (auditoria de conformidade EST-004, 2026-10-08): a validação acima só
  // cobria a direção "projectId informado sem projectLocationId" — faltava a direção simétrica.
  // Sem ela, uma requisição apontando "projectLocationId" para um InventoryLocation
  // PROJECT_SITE sem informar projectId/stageId era aceita normalmente, e o OUT gerado depois em
  // issueRequisition saía com projectId: null — um movimento tocando local de obra sem vínculo
  // de obra, quebrando a rastreabilidade exigida pelo EST-004 (mesmo padrão já corrigido em
  // movements.service.js#recordMovement e counts.service.js#openCount).
  // ACHADO REAL (auditoria Nayara, Marco 7 final): a requisição aceitava uma "Obra" escolhida à
  // mão divergente da obra REAL já vinculada ao canteiro de destino (desde a correção F2 desta
  // sessão, todo canteiro já nasce vinculado a uma obra no cadastro) — o OUT acabava sendo
  // gravado com a obra errada. A obra do canteiro é sempre a fonte de verdade: se o canteiro já
  // tem uma obra, ela SOBRESCREVE qualquer projectId divergente enviado pelo front (nunca
  // confiamos em obra escolhida solta no formulário quando o canteiro já sabe a dele). Roda ANTES
  // da validação de stageId abaixo, pra validar a etapa contra a obra já corrigida/confirmada.
  if (projectLocationId) {
    const projectLocation = await InventoryLocation.findOne({ where: { id: projectLocationId, groupId, companyId }, transaction });
    if (!projectLocation) throw AppError.notFound('Local de destino no canteiro não encontrado.', 'INVENTORY_LOCATION_NOT_FOUND');
    if (projectLocation.locationType === 'PROJECT_SITE') {
      if (projectLocation.projectId) {
        // Canteiro já vinculado a uma obra no cadastro: essa é a única obra válida pra essa
        // requisição, independente do que o formulário tiver enviado. Revisão Marco 7
        // (19/10/2026), A7: a etapa deixou de ser descartada em silêncio quando não pertence a
        // essa obra — com a etapa obrigatória, a validação abaixo recusa com erro claro.
        projectId = projectLocation.projectId;
      } else if (!projectId) {
        // Canteiro legado (criado antes da correção F2), ainda sem obra no próprio cadastro —
        // mantém a exigência antiga de informar a obra na requisição.
        throw AppError.badRequest(
          'O local de destino é um canteiro de obra — selecione a obra (e a etapa, se aplicável) para vincular a requisição.',
          'REQUISITION_PROJECT_LOCATION_REQUIRES_PROJECT'
        );
      }
    }
  }

  // GAP REAL CORRIGIDO (auditoria de conformidade contratual Marco 7, 2026-10-07): EST-004 exige
  // project_id/stage_id — stageId era gravado sem nenhuma validação (aceitava etapa de OUTRA obra
  // ou etapa sem obra nenhuma). Mesmo padrão de materialRequests.service.js#createMaterialRequest.
  // Revisão Marco 7 (19/10/2026), A7 — EST-004 / Caderno §5 ("Obra/etapa solicita material";
  // "OUT vincula project_id/stage_id"): requisição para obra sem etapa era aceita e virava OUT
  // sem etapa. Agora a etapa é obrigatória sempre que houver obra.
  if (projectId && !stageId) {
    throw AppError.badRequest('Requisição para obra exige a etapa — escolha em qual etapa o material será usado.', 'INVENTORY_REQUISITION_STAGE_REQUIRED');
  }
  if (stageId) {
    if (!projectId) {
      throw AppError.badRequest('Informe a obra antes de escolher a etapa (a etapa pertence a uma obra).', 'INVENTORY_REQUISITION_VALIDATION');
    }
    const stage = await ProjectStage.findOne({ where: { id: stageId, projectId }, transaction });
    if (!stage) {
      throw AppError.badRequest('A etapa escolhida não pertence à obra selecionada.', 'INVENTORY_REQUISITION_STAGE_INVALID');
    }
  }

  const requisition = await InventoryRequisition.create(
    {
      groupId,
      companyId,
      warehouseLocationId,
      projectLocationId: projectLocationId || null,
      projectId: projectId || null,
      stageId: stageId || null,
      notes: notes || null,
      status: 'REQUESTED',
      requestedByUserId: actorUserId || null,
      createdBy: actorUserId || null,
      updatedBy: actorUserId || null,
    },
    { transaction }
  );

  for (const line of items) {
    const item = await InventoryItem.findOne({ where: { id: line.inventoryItemId, groupId, companyId }, transaction });
    if (!item) throw AppError.notFound(`Item de estoque "${line.inventoryItemId}" não encontrado.`, 'INVENTORY_ITEM_NOT_FOUND');
    await InventoryRequisitionItem.create(
      { groupId, companyId, requisitionId: requisition.id, inventoryItemId: line.inventoryItemId, quantity: line.quantity },
      { transaction }
    );
  }

  await publishRequisitionCreated(requisition, transaction);

  await registrarAuditoria(
    { groupId, companyId, actorUserId, action: 'INVENTORY_REQUISITION_CREATED', entityType: 'InventoryRequisition', entityId: requisition.id,
      afterJson: {
        ...requisition.toJSON(),
        items: items.map((l) => ({ inventoryItemId: l.inventoryItemId, quantity: l.quantity })),
      },
      reason: 'Requisição de material criada.' },
    transaction
  );

  return getRequisition(requisition.id, groupId, companyId, transaction);
}

async function getRequisition(requisitionId, groupId, companyId, transaction) {
  const requisition = await InventoryRequisition.findOne({
    where: { id: requisitionId, groupId, companyId },
    include: [{ model: InventoryRequisitionItem, as: 'items' }],
    transaction,
  });
  if (!requisition) throw AppError.notFound('Requisição não encontrada.', 'INVENTORY_REQUISITION_NOT_FOUND');
  return requisition;
}

// BUG REAL CORRIGIDO (auditoria "loop até secar", rodada 53, 2026-10-05): listRequisitions
// nunca incluía os itens (só getRequisition incluía) — a tela de lista só conseguia mostrar o
// status agregado, nunca quais itens/quantidades foram solicitados, mesmo padrão de bug já
// corrigido em R52 pra comparação de cotações (só total, nunca item a item).
async function listRequisitions(groupId, companyId, transaction, { status, projectId } = {}) {
  const where = { groupId, companyId };
  if (status) where.status = status;
  if (projectId) where.projectId = projectId;
  return InventoryRequisition.findAll({
    where,
    include: [
      { model: InventoryRequisitionItem, as: 'items' },
      { model: Project, as: 'project', attributes: ['id', 'name'] },
      // Nome do solicitante (auditoria Marco 7 "r2", 2026-10-17): a tela só tinha o UUID.
      { model: User, as: 'requestedByUser', attributes: ['id', 'name'] },
    ],
    order: [['created_at', 'DESC']],
    limit: 1500,
    transaction,
  });
}

async function decideRequisition(requisitionId, decision, actorUserId, groupId, companyId, transaction) {
  if (!['APPROVED', 'REJECTED'].includes(decision)) {
    throw AppError.badRequest('"decision" precisa ser "APPROVED" ou "REJECTED".', 'INVENTORY_REQUISITION_VALIDATION');
  }
  const requisition = await InventoryRequisition.findOne({ where: { id: requisitionId, groupId, companyId }, transaction, lock: transaction.LOCK.UPDATE });
  if (!requisition) throw AppError.notFound('Requisição não encontrada.', 'INVENTORY_REQUISITION_NOT_FOUND');
  if (requisition.status !== 'REQUESTED') {
    throw AppError.badRequest(`Só é possível decidir uma requisição em REQUESTED (atual: ${requisition.status}).`, 'INVENTORY_REQUISITION_INVALID_TRANSITION');
  }
  // ACHADO REAL (apontado em 3 rodadas independentes de auditoria, Marco 7): quem cria a
  // requisição podia aprovar/rejeitar a própria solicitação, inconsistente com o mesmo bloqueio
  // já aplicado em Compras e no Ajuste de inventário. Mesmo padrão: fail closed, mensagem clara.
  if (requisition.requestedByUserId && actorUserId && String(requisition.requestedByUserId) === String(actorUserId)) {
    throw AppError.forbidden(
      'Quem solicitou esta requisição não pode aprová-la/rejeitá-la — peça a decisão de outra pessoa com permissão.',
      'INVENTORY_REQUISITION_SELF_APPROVAL_BLOCKED'
    );
  }
  const auditBefore = { status: requisition.status, approvedByUserId: requisition.approvedByUserId, requestedByUserId: requisition.requestedByUserId };
  requisition.status = decision;
  requisition.approvedByUserId = actorUserId || null;
  requisition.updatedBy = actorUserId || null;
  await requisition.save({ transaction });
  await registrarAuditoria(
    {
      groupId: requisition.groupId,
      companyId: requisition.companyId,
      actorUserId,
      action: 'INVENTORY_REQUISITION_DECIDED',
      entityType: 'InventoryRequisition',
      entityId: requisition.id,
      beforeJson: auditBefore,
      afterJson: { status: requisition.status, approvedByUserId: requisition.approvedByUserId, requestedByUserId: requisition.requestedByUserId },
      reason: decision === 'APPROVED' ? 'Requisição de material aprovada.' : 'Requisição de material rejeitada.',
    },
    transaction
  );
  return requisition;
}

// Revisão Marco 7 (19/10/2026), A7 — Caderno §5 "OUT vincula project_id/stage_id e responsável":
// a entrega para obra passa a exigir a pessoa que recebe o material (responsiblePersonId, do
// cadastro de Pessoas desta empresa), gravada no OUT e na entrada no canteiro.
async function issueRequisition(requisitionId, actor, groupId, companyId, transaction, payload = {}) {
  const requisition = await InventoryRequisition.findOne({ where: { id: requisitionId, groupId, companyId }, transaction, lock: transaction.LOCK.UPDATE });
  if (!requisition) throw AppError.notFound('Requisição não encontrada.', 'INVENTORY_REQUISITION_NOT_FOUND');
  if (requisition.status !== 'APPROVED') {
    throw AppError.badRequest(`Só é possível entregar uma requisição em APPROVED (atual: ${requisition.status}).`, 'INVENTORY_REQUISITION_INVALID_TRANSITION');
  }
  const responsiblePersonId = payload?.responsiblePersonId || null;
  if (requisition.projectId && !responsiblePersonId) {
    throw AppError.badRequest('Entrega para obra exige o responsável que recebe o material.', 'INVENTORY_REQUISITION_RESPONSIBLE_REQUIRED');
  }
  if (responsiblePersonId) {
    const responsible = await Person.findOne({ where: { id: responsiblePersonId, groupId, companyId }, transaction });
    if (!responsible) {
      throw AppError.badRequest('Responsável informado não encontrado no cadastro de pessoas desta empresa.', 'INVENTORY_REQUISITION_RESPONSIBLE_NOT_FOUND');
    }
  }
  const items = await InventoryRequisitionItem.findAll({ where: { requisitionId: requisition.id, groupId, companyId }, transaction });

  const project = requisition.projectId
    ? await Project.findOne({ where: { id: requisition.projectId, groupId, companyId }, transaction })
    : null;
  const issueReason = project
    ? `Entrega de requisição de material — obra "${project.name}".`
    : 'Entrega de requisição de material.';

  for (const line of items) {
    await recordMovement(
      {
        groupId: requisition.groupId,
        companyId: requisition.companyId,
        inventoryItemId: line.inventoryItemId,
        projectId: requisition.projectId,
        stageId: requisition.stageId,
        movementType: 'OUT',
        quantity: Number(line.quantity) - Number(line.issuedQuantity),
        sourceLocationId: requisition.warehouseLocationId,
        responsiblePersonId: responsiblePersonId || undefined,
        sourceType: 'REQUISITION',
        sourceId: requisition.id,
        idempotencyKey: `req:${requisition.id}:item:${line.id}`,
        reason: issueReason,
      },
      actor,
      transaction
    );
    line.issuedQuantity = line.quantity;
    await line.save({ transaction });
  }

  const auditBefore = {
    status: requisition.status,
    warehouseLocationId: requisition.warehouseLocationId,
    projectLocationId: requisition.projectLocationId,
    lines: items.map((l) => ({ inventoryItemId: l.inventoryItemId, quantity: l.quantity, issuedQuantity: l.issuedQuantity })),
  };
  requisition.status = 'ISSUED';
  requisition.updatedBy = actor.userId || null;
  await requisition.save({ transaction });

  // Se a requisição tem destino no canteiro (projectLocationId), a baixa do almoxarifado
  // precisa ser completada por uma entrada no local da obra — modelada como TRANSFER, não como
  // dois OUT, pra manter atomicidade igual ao resto do ledger (EST-003).
  if (requisition.projectLocationId) {
    for (const line of items) {
      await recordMovement(
        {
          groupId: requisition.groupId,
          companyId: requisition.companyId,
          inventoryItemId: line.inventoryItemId,
          movementType: 'IN',
          quantity: line.quantity,
          destinationLocationId: requisition.projectLocationId,
          projectId: requisition.projectId,
          stageId: requisition.stageId,
          responsiblePersonId: responsiblePersonId || undefined,
          sourceType: 'REQUISITION',
          sourceId: requisition.id,
          idempotencyKey: `req:${requisition.id}:item:${line.id}:site-in`,
          reason: issueReason,
        },
        actor,
        transaction
      );
    }
  }

  await registrarAuditoria(
    { groupId: requisition.groupId, companyId: requisition.companyId, actorUserId: actor.userId, action: 'INVENTORY_REQUISITION_ISSUED', entityType: 'InventoryRequisition', entityId: requisition.id,
      beforeJson: auditBefore,
      afterJson: {
        status: requisition.status,
        warehouseLocationId: requisition.warehouseLocationId,
        projectLocationId: requisition.projectLocationId,
        responsiblePersonId,
        lines: items.map((l) => ({ inventoryItemId: l.inventoryItemId, quantity: l.quantity, issuedQuantity: l.issuedQuantity })),
      },
      reason: 'Requisição entregue — baixa de estoque gerada.' },
    transaction
  );

  return requisition;
}

module.exports = { STATUSES, createRequisition, getRequisition, listRequisitions, decideRequisition, issueRequisition };
