'use strict';

const { MaterialRequest, Project, ProjectStage, InventoryItem, InventoryMovement } = require('../../models');
const AppError = require('../../utils/AppError');
const { registrarAuditoria } = require('../../engines/audit/auditLog.service');
const { publishMaterialRequested, publishMaterialReceived } = require('./constructionEvents.service');
const { recordMovement } = require('../inventory/movements.service');
const { setReturnCondition } = require('../inventory/returnConditionColumns');

// GAP 2 (fechamento de auditoria externa Nayara, Marco 6): condição aceita na devolução —
// REUSABLE (volta ao estoque normal, reaproveitável), DAMAGED (volta danificado — custo de
// devolução distinto do custo original do item, mas o material fisicamente voltou e por isso
// credita o saldo), LOST (NUNCA volta fisicamente — ver BUG REAL CORRIGIDO abaixo em
// returnMaterialRequest: até 09/10/2026 esse caso gerava o MESMO movimento RETURN que credita
// saldo, permitindo "devolver" material perdido e inflar o estoque; corrigido para LOST nunca
// creditar nada).
const RETURN_CONDITION_CODES = ['REUSABLE', 'DAMAGED', 'LOST'];

// M6-28 — requisição de material nascida da obra/etapa.
// GAP CORRIGIDO (auditoria pós-Marco 6, item 5): a versão anterior só registrava a requisição
// e marcava status RECEIVED, sem gerar o movimento de saída real no Estoque — o saldo de
// `inventory.inventory_items`/`inventory.stock_balances` nunca era debitado de fato.
// `receiveMaterialRequest` agora aceita opcionalmente `inventoryItemId` + `sourceLocationId` no
// momento do recebimento (quem recebe o material sabe de qual item/local do almoxarifado ele
// efetivamente saiu) e, quando informados, chama `inventory/movements.service.js#recordMovement`
// com um OUT real, vinculado ao `projectId` da obra (EST-004), dentro da MESMA transação —
// `InventoryMovement.sourceType='REQUISITION'`/`sourceId=materialRequest.id` dá a rastreabilidade
// de volta pra requisição, sem precisar de coluna nova em `construction.material_requests`
// (decisão de engenharia: evita uma migration de schema para este fix pontual — o vínculo vive
// no lado do Estoque, que já tem `source_type`/`source_id` para isso). Requisição sem esses
// dados no recebimento continua funcionando como antes (registro sem movimento), documentado,
// não escondido.
const STATUSES = ['REQUESTED', 'RECEIVED'];

async function createMaterialRequest(projectId, payload, actorUserId, transaction) {
  const { groupId, companyId, stageId, description, quantity, unit, idempotencyKey } = payload;
  if (!groupId || !companyId || !description || quantity == null || !unit) {
    throw AppError.badRequest(
      'Os campos "groupId", "companyId", "description", "quantity" e "unit" são obrigatórios.',
      'MATERIAL_REQUEST_VALIDATION'
    );
  }
  if (!Number.isFinite(Number(quantity)) || Number(quantity) <= 0) {
    throw AppError.badRequest('"quantity" precisa ser maior que zero.', 'MATERIAL_REQUEST_VALIDATION');
  }

  // Item 3 (fechamento de gaps pós-Marco 6) — mesmo padrão de captura offline do RDO (M6-94,
  // ver dailyReports.service.js#createDailyReport) e da medição (createStageMeasurement acima
  // no módulo): se esta `idempotencyKey` já criou uma requisição, devolve o registro existente
  // em vez de duplicar. O UNIQUE parcial do banco (migration 20260101000295) é a garantia final.
  if (idempotencyKey) {
    const existingByIdempotency = await MaterialRequest.findOne({ where: { idempotencyKey }, transaction });
    if (existingByIdempotency) {
      return existingByIdempotency;
    }
  }

  const project = await Project.findByPk(projectId, { transaction });
  if (!project) throw AppError.notFound('Obra não encontrada.', 'PROJECT_NOT_FOUND');

  if (stageId) {
    const stage = await ProjectStage.findOne({ where: { id: stageId, projectId }, transaction });
    if (!stage) {
      throw AppError.badRequest('"stageId" não corresponde a uma etapa desta obra.', 'MATERIAL_REQUEST_STAGE_INVALID');
    }
  }

  const materialRequest = await MaterialRequest.create(
    {
      groupId,
      companyId,
      projectId,
      stageId: stageId || null,
      description,
      quantity,
      unit,
      status: 'REQUESTED',
      requestedByUserId: actorUserId || null,
      idempotencyKey: idempotencyKey || null,
      createdBy: actorUserId || null,
      updatedBy: actorUserId || null,
    },
    { transaction }
  );

  await publishMaterialRequested(materialRequest, transaction);

  await registrarAuditoria(
    {
      groupId,
      companyId,
      actorUserId,
      action: 'construction.material_request.create',
      entityType: 'MaterialRequest',
      entityId: materialRequest.id,
      afterJson: materialRequest.toJSON(),
      reason: `Requisição de material "${description}" criada para a obra ${projectId}.`,
    },
    transaction
  );

  return materialRequest;
}

async function listMaterialRequests(projectId, transaction, filters = {}) {
  const where = { projectId };
  if (filters.status) where.status = String(filters.status).toUpperCase();
  return MaterialRequest.findAll({ where, order: [['created_at', 'DESC']], transaction });
}

// BUG REAL CORRIGIDO (reauditoria RLS/multi-tenant, rodada 5, 2026-10-08): findByPk(id) sem
// filtro de groupId/companyId em getMaterialRequest/receiveMaterialRequest/returnMaterialRequest
// deixava qualquer tenant ler ou agir (receber, devolver — inclusive creditando estoque) sobre a
// requisição de material de OUTRA empresa só adivinhando o UUID. Projeto não usa RLS real do
// Postgres (SET LOCAL app.group_id/company_id em tenant.middleware.js não tem CREATE POLICY
// correspondente) — isolamento é 100% a cargo do filtro manual no where, que faltava aqui.
async function getMaterialRequest(id, groupId, companyId, transaction) {
  const materialRequest = await MaterialRequest.findOne({ where: { id, groupId, companyId }, transaction });
  if (!materialRequest) throw AppError.notFound('Requisição de material não encontrada.', 'MATERIAL_REQUEST_NOT_FOUND');
  return materialRequest;
}

async function receiveMaterialRequest(id, groupId, companyId, actorUserId, transaction, stockLink = {}) {
  // Lock pessimista: mesma justificativa das outras máquinas de estado do módulo (ver
  // transitionProject em projects.service.js) — evita duas confirmações de recebimento
  // concorrentes disparando o evento `material.received` duas vezes para o mesmo registro.
  const materialRequest = await MaterialRequest.findOne({
    where: { id, groupId, companyId },
    transaction,
    lock: transaction ? transaction.LOCK.UPDATE : undefined,
  });
  if (!materialRequest) throw AppError.notFound('Requisição de material não encontrada.', 'MATERIAL_REQUEST_NOT_FOUND');
  const beforeJson = materialRequest.toJSON();

  if (materialRequest.status === 'RECEIVED') {
    throw AppError.conflict('Esta requisição de material já foi marcada como recebida.', 'MATERIAL_REQUEST_ALREADY_RECEIVED');
  }

  // BUG REAL CORRIGIDO (auditoria externa Nayara, 2026-10-07; contrato §7/§8: "Requisição nasce
  // da obra/etapa; recebimento integra Estoque" / "OUT vincula project_id/stage_id e
  // responsável"): item/local do estoque eram opcionais no recebimento, permitindo marcar uma
  // requisição como "recebida" sem nenhuma baixa real de saldo, custo ou rastreabilidade —
  // exatamente o cenário reproduzido no reteste (2 unidades "recebidas" sem vínculo nenhum).
  // Fail closed: agora são obrigatórios.
  const { inventoryItemId, sourceLocationId } = stockLink || {};
  if (!inventoryItemId || !sourceLocationId) {
    throw AppError.badRequest(
      'Confirmar o recebimento exige "inventoryItemId" e "sourceLocationId" (de qual item/local do estoque o material saiu).',
      'MATERIAL_REQUEST_STOCK_LINK_REQUIRED'
    );
  }

  materialRequest.status = 'RECEIVED';
  materialRequest.receivedAt = new Date();
  materialRequest.updatedBy = actorUserId || null;
  await materialRequest.save({ transaction });

  // Baixa real de saldo no Estoque — vincula item/local informados pelo recebimento.
  const inventoryMovement = await recordMovement(
    {
      groupId: materialRequest.groupId,
      companyId: materialRequest.companyId,
      inventoryItemId,
      projectId: materialRequest.projectId,
      stageId: materialRequest.stageId,
      movementType: 'OUT',
      quantity: materialRequest.quantity,
      sourceLocationId,
      sourceType: 'REQUISITION',
      sourceId: materialRequest.id,
      idempotencyKey: `material_request.receive:${materialRequest.id}`,
      reason: `Consumo da requisição de material "${materialRequest.description}" na obra ${materialRequest.projectId}.`,
    },
    { userId: actorUserId, canApprove: false },
    transaction
  );

  await publishMaterialReceived(materialRequest, transaction);

  await registrarAuditoria(
    {
      groupId: materialRequest.groupId,
      companyId: materialRequest.companyId,
      actorUserId,
      action: 'construction.material_request.receive',
      entityType: 'MaterialRequest',
      entityId: materialRequest.id,
      beforeJson,
      afterJson: { ...materialRequest.toJSON(), inventoryMovementId: inventoryMovement ? inventoryMovement.id : null },
      reason: `Requisição de material "${materialRequest.description}" marcada como recebida.`,
    },
    transaction
  );

  return materialRequest;
}

/**
 * returnMaterialRequest — devolução de material já recebido (contrato §8: "Devolução/
 * reaproveitamento gera movimento inverso"). Gera um movimento RETURN real no Estoque,
 * creditando de volta o saldo do item/local de onde ele tinha saído — nunca ajusta o saldo
 * "na mão", sempre pelo ledger (mesmo princípio EST-002/EST-003 usado no resto do módulo).
 * Idempotente por requisição: devolver a mesma requisição duas vezes não duplica o crédito.
 */
async function returnMaterialRequest(id, groupId, companyId, payload, actorUserId, transaction) {
  const materialRequest = await MaterialRequest.findOne({
    where: { id, groupId, companyId },
    transaction,
    lock: transaction ? transaction.LOCK.UPDATE : undefined,
  });
  if (!materialRequest) throw AppError.notFound('Requisição de material não encontrada.', 'MATERIAL_REQUEST_NOT_FOUND');
  if (materialRequest.status !== 'RECEIVED') {
    throw AppError.conflict('Só é possível devolver material de uma requisição já recebida.', 'MATERIAL_REQUEST_RETURN_REQUIRES_RECEIVED');
  }

  const { inventoryItemId, destinationLocationId, quantity, reason } = payload || {};
  if (!inventoryItemId || !destinationLocationId) {
    throw AppError.badRequest(
      'A devolução exige "inventoryItemId" e "destinationLocationId" (para onde o material volta no estoque).',
      'MATERIAL_REQUEST_RETURN_VALIDATION'
    );
  }
  const returnQuantity = quantity != null ? Number(quantity) : Number(materialRequest.quantity);
  if (!Number.isFinite(returnQuantity) || returnQuantity <= 0 || returnQuantity > Number(materialRequest.quantity)) {
    throw AppError.badRequest('"quantity" da devolução precisa ser maior que zero e não pode exceder a quantidade recebida.', 'MATERIAL_REQUEST_RETURN_VALIDATION');
  }

  // BUG REAL CORRIGIDO (auditoria externa Nayara, reteste 09/10/2026 — "troca de item": a
  // requisição consumiu 2 unidades do item A, mas a devolução aceitava 2 unidades do item B sem
  // nenhuma checagem, creditando estoque de um item que nunca saiu desta requisição). Busca o
  // movimento OUT original (gravado em receiveMaterialRequest, mesmo sourceType/sourceId) e
  // exige que o item devolvido seja o MESMO que foi consumido.
  const originalOutMovement = await InventoryMovement.findOne({
    where: { sourceType: 'REQUISITION', sourceId: materialRequest.id, movementType: 'OUT' },
    transaction,
  });
  if (originalOutMovement && originalOutMovement.inventoryItemId !== inventoryItemId) {
    throw AppError.badRequest(
      'O item devolvido precisa ser o mesmo item que foi consumido por esta requisição (vínculo com a saída original).',
      'MATERIAL_REQUEST_RETURN_ITEM_MISMATCH'
    );
  }

  // GAP 2 (fechamento de auditoria externa Nayara, Marco 6) — "reaproveitamento de materiais" +
  // "custo de devolução distinto do custo original": `reusable` (default true, mesmo
  // comportamento anterior preservado — devolução sempre creditava saldo normal) e
  // `conditionCode`/`returnCost` (opcionais) documentam EM QUE CONDIÇÃO o material voltou.
  const reusable = payload && payload.reusable != null ? Boolean(payload.reusable) : true;
  const conditionCode = payload && payload.conditionCode ? String(payload.conditionCode).toUpperCase() : 'REUSABLE';
  if (!RETURN_CONDITION_CODES.includes(conditionCode)) {
    throw AppError.badRequest(`"conditionCode" precisa ser um de: ${RETURN_CONDITION_CODES.join(', ')}.`, 'MATERIAL_REQUEST_RETURN_VALIDATION');
  }
  // Custo de devolução distinto do custo ORIGINAL do item (inventory_items.average_cost):
  // quando a condição é DAMAGED, o material voltou com valor reduzido — default 0 (perda total
  // de valor) se nenhum `returnCost` explícito for informado pelo conferente.
  let returnCost = null;
  if (payload && payload.returnCost != null) {
    returnCost = Number(payload.returnCost);
    if (!Number.isFinite(returnCost) || returnCost < 0) {
      throw AppError.badRequest('"returnCost" precisa ser um número não negativo.', 'MATERIAL_REQUEST_RETURN_VALIDATION');
    }
  } else if (conditionCode === 'DAMAGED') {
    returnCost = 0;
  }
  const inventoryItem = await InventoryItem.findByPk(inventoryItemId, { transaction });
  const originalUnitCost = inventoryItem && inventoryItem.averageCost != null ? Number(inventoryItem.averageCost) : null;

  const beforeJson = materialRequest.toJSON();
  // BUG REAL CORRIGIDO (auditoria externa Nayara, reteste 09/10/2026 — "material perdido": uma
  // saída reduzia o saldo de 10 para 8, e registrar a devolução como LOST/reusable=false AINDA
  // gerava o movimento RETURN (que sempre credita +quantity), fazendo o saldo voltar pra 10
  // mesmo o material nunca tendo voltado fisicamente. LOST agora NUNCA credita estoque — só
  // registra a trilha de auditoria abaixo, sem nenhum movimento de crédito.
  const inventoryMovement = conditionCode === 'LOST'
    ? null
    : await recordMovement(
        {
          groupId: materialRequest.groupId,
          companyId: materialRequest.companyId,
          inventoryItemId,
          projectId: materialRequest.projectId,
          stageId: materialRequest.stageId,
          movementType: 'RETURN',
          quantity: returnQuantity,
          destinationLocationId,
          sourceType: 'REQUISITION',
          sourceId: materialRequest.id,
          idempotencyKey: `material_request.return:${materialRequest.id}`,
          reason: reason || `Devolução de material da requisição "${materialRequest.description}" (obra ${materialRequest.projectId}) — condição: ${conditionCode}.`,
        },
        { userId: actorUserId, canApprove: false },
        transaction
      );

  // Persiste reusable/conditionCode/returnCost nas 3 colunas reais de
  // "inventory"."inventory_movements" assim que a migration 20260101000303 (criada junto com
  // este gap) rodar neste ambiente — ver doc completo em
  // src/features/inventory/returnConditionColumns.js. Até lá, fail-open (não quebra a
  // devolução) e o dado fica garantido via o registro de auditoria abaixo (tabela
  // "audit"."audit_log", já existente/aplicada, consultável por entityId=materialRequest.id).
  if (inventoryMovement) {
    await setReturnCondition(inventoryMovement.id, { reusable, conditionCode, returnCost }, transaction);
  }

  const returnDetails = { reusable, conditionCode, returnCost, originalUnitCost };

  await registrarAuditoria(
    {
      groupId: materialRequest.groupId,
      companyId: materialRequest.companyId,
      actorUserId,
      action: 'construction.material_request.return',
      entityType: 'MaterialRequest',
      entityId: materialRequest.id,
      beforeJson,
      afterJson: { ...materialRequest.toJSON(), returnMovementId: inventoryMovement ? inventoryMovement.id : null, ...returnDetails },
      reason: `Devolução de ${returnQuantity} ${materialRequest.unit} da requisição "${materialRequest.description}" — condição ${conditionCode}${conditionCode === 'LOST' ? ' (material NÃO voltou fisicamente — nenhum crédito de estoque aplicado)' : ''}${conditionCode === 'DAMAGED' ? `, custo de devolução ${returnCost} (custo original do item: ${originalUnitCost == null ? 'desconhecido' : originalUnitCost})` : ''}.`,
    },
    transaction
  );

  return { materialRequest, returnMovement: inventoryMovement, returnDetails };
}

module.exports = {
  createMaterialRequest,
  listMaterialRequests,
  getMaterialRequest,
  receiveMaterialRequest,
  returnMaterialRequest,
  STATUSES,
};
