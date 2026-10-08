'use strict';

const { InventoryCount, InventoryCountItem, InventoryStockBalance, InventoryLocation } = require('../../models');
const AppError = require('../../utils/AppError');
const { registrarAuditoria } = require('../../engines/audit/auditLog.service');
const { recordMovement } = require('./movements.service');
const { publishCountCompleted } = require('./inventoryEvents.service');

// Guia do Marcelo §8/item 10 do Caderno: contagem NUNCA altera saldo direto (EST-TS-09) — o
// fechamento só trava expected_quantity/divergence; ajuste de verdade é um ato separado e
// aprovado (applyAdjustment -> movements.service ADJUSTMENT, com reason obrigatório).
async function openCount(payload, actorUserId, transaction) {
  const { groupId, companyId, locationId, projectId } = payload;
  if (!groupId || !companyId || !locationId) {
    throw AppError.badRequest('Os campos "groupId", "companyId" e "locationId" são obrigatórios.', 'INVENTORY_COUNT_VALIDATION');
  }
  // BUG REAL CORRIGIDO (auditoria E2E Marco 7, ciclo 7): inventário físico aberto num local
  // PROJECT_SITE sem projectId ficava impossível de ajustar depois — applyAdjustment propaga
  // count.projectId pro ADJUSTMENT gerado, e recordMovement bloqueia (EST-004) qualquer
  // movimento tocando local PROJECT_SITE sem projectId. Sem essa validação na abertura, a
  // contagem era aceita normalmente e só travava, sem solução, na hora de aplicar o ajuste.
  //
  // Caderno §10 — freeze lógico (ver movements.service.js#assertLocationsNotFrozenByCount): o
  // FOR UPDATE no local serializa a abertura com qualquer movimento em voo no mesmo local
  // (recordMovement trava o local com FOR SHARE). Também impede duas contagens OPEN no mesmo
  // local (duas aberturas concorrentes esperam uma pela outra aqui).
  const location = await InventoryLocation.findByPk(locationId, { transaction, lock: transaction.LOCK.UPDATE });
  if (!location) throw AppError.notFound('Local de estoque não encontrado.', 'INVENTORY_LOCATION_NOT_FOUND');
  if (location.locationType === 'PROJECT_SITE' && !projectId) {
    throw AppError.badRequest('Inventário num local de obra (PROJECT_SITE) exige "projectId" (EST-004).', 'INVENTORY_COUNT_PROJECT_REQUIRED');
  }
  const alreadyOpen = await InventoryCount.findOne({ where: { locationId, status: 'OPEN' }, transaction });
  if (alreadyOpen) {
    throw AppError.conflict(`Já existe um inventário OPEN para este local (${alreadyOpen.id}) — conclua-o antes de abrir outro.`, 'INVENTORY_COUNT_ALREADY_OPEN');
  }
  const count = await InventoryCount.create(
    { groupId, companyId, locationId, projectId: projectId || null, status: 'OPEN', createdBy: actorUserId || null, updatedBy: actorUserId || null },
    { transaction }
  );
  await registrarAuditoria(
    { groupId, companyId, actorUserId, action: 'INVENTORY_COUNT_OPENED', entityType: 'InventoryCount', entityId: count.id, reason: 'Inventário físico aberto.' },
    transaction
  );
  return count;
}

// BUG REAL CORRIGIDO (auditoria "loop até secar", rodada 58, 2026-10-06): guard usava
// `Number(countedQuantity) < 0`, falso para NaN — countedQuantity:"NaN" passava (Postgres NUMERIC
// aceita o literal 'NaN'), persistindo divergence=NaN sem caminho de correção via API (todo
// applyAdjustment subsequente falhava sem apontar a causa real).
// BUG REAL CORRIGIDO (reauditoria RLS/multi-tenant, 2026-10-08): findByPk(id) sem filtro de
// groupId/companyId em addCountItem/completeCount/getCount/applyAdjustment deixava qualquer
// tenant ler ou agir sobre o inventário de OUTRA empresa só adivinhando o UUID. Projeto não usa
// RLS real do Postgres — isolamento é 100% a cargo do filtro manual no where, que faltava aqui
// (mesmo padrão já corrigido em materialRequests.service.js/adjustmentRiskRules.service.js).
async function addCountItem(countId, groupId, companyId, payload, transaction) {
  const { inventoryItemId, countedQuantity } = payload;
  if (!inventoryItemId || countedQuantity == null || !Number.isFinite(Number(countedQuantity)) || Number(countedQuantity) < 0) {
    throw AppError.badRequest('"inventoryItemId" e "countedQuantity" (>= 0) são obrigatórios.', 'INVENTORY_COUNT_VALIDATION');
  }
  // FOR SHARE: serializa com completeCount (FOR UPDATE na mesma linha) — uma linha contada não
  // pode entrar depois do fechamento já ter calculado as divergências.
  const count = await InventoryCount.findOne({ where: { id: countId, groupId, companyId }, transaction, lock: transaction.LOCK.SHARE });
  if (!count) throw AppError.notFound('Inventário não encontrado.', 'INVENTORY_COUNT_NOT_FOUND');
  if (count.status !== 'OPEN') {
    throw AppError.badRequest(`Só é possível contar itens em um inventário OPEN (atual: ${count.status}).`, 'INVENTORY_COUNT_INVALID_TRANSITION');
  }

  const [line, created] = await InventoryCountItem.findOrCreate({
    where: { countId, inventoryItemId },
    defaults: { groupId: count.groupId, companyId: count.companyId, countId, inventoryItemId, countedQuantity },
    transaction,
  });
  if (!created) {
    line.countedQuantity = countedQuantity;
    await line.save({ transaction });
  }
  return line;
}

async function completeCount(countId, groupId, companyId, actorUserId, transaction) {
  const count = await InventoryCount.findOne({ where: { id: countId, groupId, companyId }, transaction, lock: transaction.LOCK.UPDATE });
  if (!count) throw AppError.notFound('Inventário não encontrado.', 'INVENTORY_COUNT_NOT_FOUND');
  if (count.status !== 'OPEN') {
    throw AppError.badRequest(`Só é possível fechar um inventário OPEN (atual: ${count.status}).`, 'INVENTORY_COUNT_INVALID_TRANSITION');
  }

  // Com o freeze lógico (Caderno §10), nenhum movimento tocou este local desde openCount — o
  // saldo lido aqui é exatamente o saldo do momento da abertura, então `divergence` é só
  // divergência real de contagem, nunca efeito de movimento posterior.
  const items = await InventoryCountItem.findAll({ where: { countId }, transaction });
  for (const line of items) {
    const balance = await InventoryStockBalance.findOne({
      where: { inventoryItemId: line.inventoryItemId, locationId: count.locationId },
      transaction,
    });
    const expected = balance ? Number(balance.quantityOnHand) : 0;
    line.expectedQuantity = expected;
    line.divergence = Number(line.countedQuantity) - expected;
    await line.save({ transaction });
  }

  count.status = 'COMPLETED';
  count.countedAt = new Date();
  count.updatedBy = actorUserId || null;
  await count.save({ transaction });

  await publishCountCompleted(count, transaction);

  await registrarAuditoria(
    { groupId: count.groupId, companyId: count.companyId, actorUserId, action: 'INVENTORY_COUNT_COMPLETED', entityType: 'InventoryCount', entityId: count.id, reason: 'Inventário físico fechado — divergências calculadas, saldo não alterado.' },
    transaction
  );

  return getCount(count.id, groupId, companyId, transaction);
}

async function getCount(countId, groupId, companyId, transaction) {
  const count = await InventoryCount.findOne({ where: { id: countId, groupId, companyId }, include: [{ model: InventoryCountItem, as: 'items' }], transaction });
  if (!count) throw AppError.notFound('Inventário não encontrado.', 'INVENTORY_COUNT_NOT_FOUND');
  return count;
}

async function listCounts(groupId, companyId, transaction, { status } = {}) {
  const where = { groupId, companyId };
  if (status) where.status = status;
  return InventoryCount.findAll({ where, order: [['created_at', 'DESC']], transaction });
}

// EST-TS-09: divergência vira "proposal" — só este endpoint, com approve explícito e reason,
// efetiva o ADJUSTMENT. Chamar de novo sobre a mesma linha é idempotente (idempotencyKey por
// count_item) e, de qualquer forma, bloqueado pelo check adjustmentMovementId != null.
// GAP REAL CORRIGIDO (EST-008/REG-EST-002, 2026-10-08): movements.service.js#recordMovement
// passou a exigir evidenceFileId para ADJUSTMENT acima do limiar de valor/risco configurado
// (Motor de Regras) — este fluxo era o único gerador de ADJUSTMENT sem nenhum jeito de
// informar evidência, o que quebraria todo ajuste de contagem de alto valor. evidenceFileId
// agora é opcional aqui (continua sendo exigido só quando o valor estimado cruzar o limiar,
// validação feita dentro de recordMovement) e propagado pro controller/rota/front.
async function applyAdjustment(countItemId, groupId, companyId, actor, transaction, evidenceFileId) {
  if (!actor.canApprove) {
    throw AppError.forbidden('Aplicar ajuste de inventário exige a permissão inventory:approve.', 'INVENTORY_COUNT_APPROVAL_REQUIRED');
  }
  const line = await InventoryCountItem.findOne({ where: { id: countItemId, groupId, companyId }, transaction, lock: transaction.LOCK.UPDATE });
  if (!line) throw AppError.notFound('Linha de contagem não encontrada.', 'INVENTORY_COUNT_ITEM_NOT_FOUND');
  if (line.adjustmentMovementId) return line;
  if (line.divergence == null || Number(line.divergence) === 0) {
    throw AppError.badRequest('Esta linha não tem divergência a ajustar.', 'INVENTORY_COUNT_NO_DIVERGENCE');
  }

  const count = await InventoryCount.findOne({ where: { id: line.countId, groupId, companyId }, transaction });
  const divergence = Number(line.divergence);

  const movement = await recordMovement(
    {
      groupId: line.groupId,
      companyId: line.companyId,
      inventoryItemId: line.inventoryItemId,
      movementType: 'ADJUSTMENT',
      quantity: Math.abs(divergence),
      destinationLocationId: divergence > 0 ? count.locationId : undefined,
      sourceLocationId: divergence < 0 ? count.locationId : undefined,
      projectId: count.projectId,
      sourceType: 'COUNT',
      sourceId: count.id,
      idempotencyKey: `count-item:${line.id}`,
      reason: `Ajuste de inventário físico ${count.id} — divergência de ${divergence}.`,
      evidenceFileId: evidenceFileId || undefined,
    },
    actor,
    transaction
  );

  line.adjustmentMovementId = movement.id;
  await line.save({ transaction });

  return line;
}

module.exports = { openCount, addCountItem, completeCount, getCount, listCounts, applyAdjustment };
