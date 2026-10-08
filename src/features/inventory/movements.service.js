'use strict';

const { InventoryCount, InventoryMovement, InventoryItem, InventoryLocation, InventoryStockBalance } = require('../../models');
const AppError = require('../../utils/AppError');
const { registrarAuditoria } = require('../../engines/audit/auditLog.service');
const { publishMovementRecorded, publishStockLow } = require('./inventoryEvents.service');
const { getMinStockPolicy, resolveMinimumForLocation } = require('./minStockRules.service');

// EST-00x (Caderno Marco 7): 7 tipos de movimento. ADJUSTMENT/LOSS/DISPOSAL exigem
// inventory:approve (mesmo padrão de alçada já usado em construction:approve/finance:approve)
// porque alteram saldo sem uma origem física rastreável (recebimento/requisição/devolução).
const MOVEMENT_TYPES = ['IN', 'OUT', 'RETURN', 'TRANSFER', 'ADJUSTMENT', 'LOSS', 'DISPOSAL'];
const APPROVAL_REQUIRED_TYPES = ['ADJUSTMENT', 'LOSS', 'DISPOSAL'];

// EST-002: saldo é sempre derivado de movimentos, nunca digitável diretamente — esta é a
// ÚNICA função do sistema que deve escrever em inventory.stock_balances.
async function applyBalanceDelta(inventoryItemId, locationId, delta, companyId, groupId, allowNegativeStock, transaction) {
  let balance = await InventoryStockBalance.findOne({
    where: { inventoryItemId, locationId },
    transaction,
    lock: transaction.LOCK.UPDATE,
  });

  if (!balance) {
    balance = await InventoryStockBalance.create(
      { groupId, companyId, inventoryItemId, locationId, quantityOnHand: 0 },
      { transaction }
    );
  }

  const nextQuantity = Number(balance.quantityOnHand) + Number(delta);
  // Documento "Banco de Dados Físico BLINDADO": "OUT não pode gerar saldo negativo QUANDO item
  // não permitir estoque negativo" — regra condicional, não incondicional (allowNegativeStock).
  if (nextQuantity < 0 && !allowNegativeStock) {
    throw AppError.badRequest(
      `Saldo insuficiente no local informado (disponível: ${balance.quantityOnHand}, solicitado: ${Math.abs(delta)}).`,
      'INVENTORY_INSUFFICIENT_BALANCE'
    );
  }

  balance.quantityOnHand = nextQuantity;
  await balance.save({ transaction });
  return balance;
}

// GAP REAL CORRIGIDO (auditoria de conformidade contratual Marco 7, 2026-10-07): Caderno §10 —
// "Durante contagem, política define freeze lógico ou reconciliação de movimentos posteriores"
// — não existia política nenhuma: um movimento registrado com a contagem aberta mudava o saldo
// "esperado" lido por completeCount no fechamento, misturando movimento legítimo com divergência
// de contagem (ajuste aplicado depois ficava errado na mesma proporção do movimento).
//
// Política escolhida: FREEZE LÓGICO (stock-take lock) por local. Enquanto existir um
// InventoryCount OPEN para um local, nenhum movimento que toque esse local (origem ou destino)
// é aceito — a contagem precisa ser concluída antes. Isso garante saldo esperado no fechamento
// == saldo na abertura, então toda divergência é divergência real de contagem.
//
// Corrida abertura x movimento resolvida no banco, por lock de linha em inventory.locations:
// - recordMovement trava cada local tocado com FOR SHARE (movimentos concorrentes no mesmo
//   local continuam paralelos entre si — SHARE não conflita com SHARE) e só então checa se há
//   contagem OPEN;
// - openCount (counts.service.js) trava o local com FOR UPDATE antes de criar a contagem.
// FOR UPDATE x FOR SHARE conflitam: a abertura espera os movimentos em voo comitarem (que
// entram no saldo esperado, antes da contagem existir), e um movimento que chega durante a
// abertura espera o commit dela e, ao destravar, enxerga a contagem OPEN (READ COMMITTED:
// cada statement vê o que já foi comitado) e é bloqueado. Locais travados em ordem de id pra
// dois movimentos TRANSFER cruzados nunca formarem deadlock com uma abertura de contagem.
async function assertLocationsNotFrozenByCount(locationIds, transaction) {
  const ids = [...new Set(locationIds.filter(Boolean))].sort();
  if (ids.length === 0) return;
  await InventoryLocation.findAll({
    where: { id: ids },
    attributes: ['id'],
    order: [['id', 'ASC']],
    lock: transaction.LOCK.SHARE,
    transaction,
  });
  const openCount = await InventoryCount.findOne({ where: { locationId: ids, status: 'OPEN' }, transaction });
  if (openCount) {
    throw AppError.conflict(
      `Local em inventário físico (contagem ${openCount.id} aberta) — movimentações neste local ficam bloqueadas até a contagem ser concluída (freeze lógico).`,
      'INVENTORY_LOCATION_FROZEN_BY_COUNT'
    );
  }
}

async function recordMovement(payload, actor, transaction) {
  const {
    groupId,
    companyId,
    inventoryItemId,
    projectId,
    movementType,
    quantity,
    sourceLocationId,
    destinationLocationId,
    sourceType,
    sourceId,
    idempotencyKey,
    movedAt,
    responsiblePersonId,
    evidenceFileId,
    reason,
  } = payload;

  if (!groupId || !companyId || !inventoryItemId || !movementType || quantity == null) {
    throw AppError.badRequest(
      'Os campos "groupId", "companyId", "inventoryItemId", "movementType" e "quantity" são obrigatórios.',
      'INVENTORY_MOVEMENT_VALIDATION'
    );
  }
  // BUG REAL CORRIGIDO (auditoria "loop até secar", rodada 47, 2026-10-05): TAB-0751 trata
  // created_by como NOT NULL — "Movimentações imutáveis de estoque" sem autor registrado
  // quebra a rastreabilidade exigida de um ledger. Nunca aceitar null aqui.
  if (!actor?.userId) {
    throw AppError.badRequest('Movimento de estoque exige um usuário autenticado ("actor.userId") — ledger imutável não pode ter autor nulo.', 'INVENTORY_MOVEMENT_ACTOR_REQUIRED');
  }
  if (!MOVEMENT_TYPES.includes(movementType)) {
    throw AppError.badRequest(`"movementType" precisa ser um de: ${MOVEMENT_TYPES.join(', ')}.`, 'INVENTORY_MOVEMENT_VALIDATION');
  }
  const qty = Number(quantity);
  if (!Number.isFinite(qty) || qty <= 0) {
    throw AppError.badRequest('"quantity" precisa ser um número maior que zero.', 'INVENTORY_MOVEMENT_VALIDATION');
  }
  if (APPROVAL_REQUIRED_TYPES.includes(movementType) && !actor.canApprove) {
    throw AppError.forbidden(
      `Movimento do tipo "${movementType}" exige a permissão inventory:approve.`,
      'INVENTORY_MOVEMENT_APPROVAL_REQUIRED'
    );
  }

  const item = await InventoryItem.findByPk(inventoryItemId, { transaction });
  if (!item) throw AppError.notFound('Item de estoque não encontrado.', 'INVENTORY_ITEM_NOT_FOUND');

  // BUG REAL CORRIGIDO (auditoria "loop até secar" — Ciclo 1, auditor Estoque/Patrimônio,
  // 2026-10-06): o checklist (MARCO_7_CHECKLIST.md §3) já apontava explicitamente que faltava
  // "validar o bloqueio 'não movimenta estoque'" de SERVICE_ITEM, mas nenhum código aqui
  // impedia — um item SERVICE_ITEM (mão de obra/serviço, sem controle físico de saldo) podia
  // receber IN/OUT/TRANSFER/ADJUSTMENT normalmente e acumular `stock_balances` fantasma, o que
  // contradiz o próprio tipo (serviço não tem unidade física armazenável).
  if (item.itemType === 'SERVICE_ITEM') {
    throw AppError.badRequest(
      'Item do tipo "SERVICE_ITEM" não movimenta estoque (não possui saldo físico).',
      'INVENTORY_MOVEMENT_SERVICE_ITEM_FORBIDDEN'
    );
  }

  if ((movementType === 'OUT' || movementType === 'LOSS' || movementType === 'DISPOSAL') && !sourceLocationId) {
    throw AppError.badRequest(`Movimento "${movementType}" exige "sourceLocationId".`, 'INVENTORY_MOVEMENT_VALIDATION');
  }
  if ((movementType === 'IN' || movementType === 'RETURN') && !destinationLocationId) {
    throw AppError.badRequest(`Movimento "${movementType}" exige "destinationLocationId".`, 'INVENTORY_MOVEMENT_VALIDATION');
  }
  if (movementType === 'TRANSFER' && (!sourceLocationId || !destinationLocationId)) {
    throw AppError.badRequest('Movimento "TRANSFER" exige "sourceLocationId" e "destinationLocationId".', 'INVENTORY_MOVEMENT_VALIDATION');
  }
  if (movementType === 'ADJUSTMENT' && !sourceLocationId && !destinationLocationId) {
    throw AppError.badRequest('Movimento "ADJUSTMENT" exige "sourceLocationId" ou "destinationLocationId".', 'INVENTORY_MOVEMENT_VALIDATION');
  }
  // EST-008: ajuste/perda/descarte exigem motivo (evidência é recomendada, mas só obrigatória
  // quando a política da empresa exigir — isso é regra de negócio do Motor de Regras, fora de
  // código fixo; aqui garantimos o mínimo "sempre obrigatório" do Caderno, que é o motivo).
  // BUG REAL CORRIGIDO (auditoria Marco 7, EST-TS-07, 2026-10-07): "   " (só espaços) passava
  // no `!reason`, gravando um ajuste/perda/descarte no ledger imutável sem motivo de verdade.
  if (APPROVAL_REQUIRED_TYPES.includes(movementType) && (!reason || !String(reason).trim())) {
    throw AppError.badRequest(`Movimento "${movementType}" exige "reason" (motivo).`, 'INVENTORY_MOVEMENT_REASON_REQUIRED');
  }
  // EST-006: saída de ferramenta/ativo (item_type TOOL/ASSET) exige responsável.
  if ((movementType === 'OUT' || movementType === 'TRANSFER') && ['TOOL', 'ASSET'].includes(item.itemType) && !responsiblePersonId) {
    throw AppError.badRequest(`Movimento "${movementType}" de ferramenta/ativo exige "responsiblePersonId".`, 'INVENTORY_MOVEMENT_VALIDATION');
  }
  // EST-004: material atribuído à obra (entra/sai de um local PROJECT_SITE) precisa de projectId.
  const touchedLocationIds = [sourceLocationId, destinationLocationId].filter(Boolean);
  if (touchedLocationIds.length > 0 && !projectId) {
    const siteLocations = await InventoryLocation.findAll({
      where: { id: touchedLocationIds, locationType: 'PROJECT_SITE' },
      transaction,
    });
    if (siteLocations.length > 0) {
      throw AppError.badRequest('Movimento envolvendo local de obra (PROJECT_SITE) exige "projectId" (EST-004).', 'INVENTORY_MOVEMENT_PROJECT_REQUIRED');
    }
  }

  // EST-00x: idempotência — reenvio do mesmo payload (ex.: retry de rede) não duplica o movimento.
  if (idempotencyKey) {
    const existing = await InventoryMovement.findOne({ where: { companyId, idempotencyKey }, transaction });
    if (existing) return existing;
  }

  // Caderno §10: freeze lógico durante inventário físico (ver assertLocationsNotFrozenByCount).
  // Depois do retorno idempotente acima: reenvio de um movimento JÁ gravado antes da contagem
  // abrir não é um movimento novo, então devolve o original em vez de falhar.
  await assertLocationsNotFrozenByCount(touchedLocationIds, transaction);

  const movement = await InventoryMovement.create(
    {
      groupId,
      companyId,
      inventoryItemId,
      projectId: projectId || null,
      movementType,
      quantity: qty,
      sourceLocationId: sourceLocationId || null,
      destinationLocationId: destinationLocationId || null,
      sourceType: sourceType || 'MANUAL',
      sourceId: sourceId || null,
      idempotencyKey: idempotencyKey || null,
      movedAt: movedAt || new Date(),
      movedByUserId: actor.userId || null,
      responsiblePersonId: responsiblePersonId || null,
      evidenceFileId: evidenceFileId || null,
      reason: reason || null,
      createdBy: actor.userId || null,
      updatedBy: actor.userId || null,
    },
    { transaction }
  );

  const allowNegative = item.allowNegativeStock;
  const touchedBalances = [];

  // Aplica o delta de saldo por local — TRANSFER move entre dois locais na mesma transação,
  // o que garante atomicidade (EST-003): nunca existe estado intermediário com saldo "perdido".
  if (movementType === 'OUT' || movementType === 'LOSS' || movementType === 'DISPOSAL') {
    touchedBalances.push(await applyBalanceDelta(inventoryItemId, sourceLocationId, -qty, companyId, groupId, allowNegative, transaction));
  } else if (movementType === 'IN' || movementType === 'RETURN') {
    touchedBalances.push(await applyBalanceDelta(inventoryItemId, destinationLocationId, qty, companyId, groupId, allowNegative, transaction));
  } else if (movementType === 'TRANSFER') {
    touchedBalances.push(await applyBalanceDelta(inventoryItemId, sourceLocationId, -qty, companyId, groupId, allowNegative, transaction));
    touchedBalances.push(await applyBalanceDelta(inventoryItemId, destinationLocationId, qty, companyId, groupId, allowNegative, transaction));
  } else if (movementType === 'ADJUSTMENT') {
    // Ajuste positivo soma no destino; ajuste negativo subtrai da origem — sinal definido por
    // qual dos dois campos veio preenchido no payload.
    if (destinationLocationId) {
      touchedBalances.push(await applyBalanceDelta(inventoryItemId, destinationLocationId, qty, companyId, groupId, allowNegative, transaction));
    } else {
      touchedBalances.push(await applyBalanceDelta(inventoryItemId, sourceLocationId, -qty, companyId, groupId, allowNegative, transaction));
    }
  }

  await registrarAuditoria(
    {
      groupId,
      companyId,
      actorUserId: actor.userId || null,
      action: 'INVENTORY_MOVEMENT_RECORDED',
      entityType: 'InventoryMovement',
      entityId: movement.id,
      afterJson: { movementType, quantity: qty, inventoryItemId, sourceLocationId, destinationLocationId },
      reason: `Movimento de estoque "${movementType}" de ${qty} unidade(s) registrado.`,
    },
    transaction
  );

  await publishMovementRecorded(movement, transaction);

  // EST-012: estoque mínimo — avisa (NAY sugere, nunca efetiva) quando o saldo resultante de
  // um local tocado por este movimento cruza para abaixo do mínimo do item NAQUELE local.
  // GAP CORRIGIDO (auditoria de conformidade Marco 7, EST-012 "Estoque mínimo e reposição vêm
  // do Motor de Regras"): o limiar vinha da coluna estática `item.minimumQuantity`; agora vem
  // exclusivamente da regra REG-EST-001 do Motor de Regras genérico (minStockRules.service.js),
  // com política por item e sobreposição opcional por local. A coluna virou só espelho legado.
  const minStockPolicy = await getMinStockPolicy(item, transaction, actor.userId);
  for (const balance of touchedBalances) {
    const threshold = resolveMinimumForLocation(minStockPolicy, balance.locationId);
    if (threshold != null && Number(balance.quantityOnHand) < threshold) {
      await publishStockLow(item, balance.locationId, balance.quantityOnHand, transaction, {
        minimumQuantity: threshold,
        reorderQuantity: minStockPolicy.reorderQuantity,
        ruleCode: minStockPolicy.ruleCode,
        ruleVersionId: minStockPolicy.ruleVersionId,
      });
    }
  }

  return movement;
}

async function getBalance(inventoryItemId, locationId, transaction) {
  const balance = await InventoryStockBalance.findOne({ where: { inventoryItemId, locationId }, transaction });
  return balance ? Number(balance.quantityOnHand) : 0;
}

async function listBalancesByItem(inventoryItemId, transaction) {
  return InventoryStockBalance.findAll({
    where: { inventoryItemId },
    include: [{ model: InventoryLocation, as: 'location' }],
    transaction,
  });
}

module.exports = { MOVEMENT_TYPES, APPROVAL_REQUIRED_TYPES, recordMovement, getBalance, listBalancesByItem, assertLocationsNotFrozenByCount };
