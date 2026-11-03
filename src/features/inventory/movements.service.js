'use strict';

const { sequelize, InventoryCount, InventoryMovement, InventoryItem, InventoryLocation, InventoryStockBalance, File, InventoryLossCase, InventoryAdjustmentProposal, ProjectStage, Project, User, Person, InventoryRequisition, InventoryRequisitionItem, MaterialRequest, InventoryReceipt, InventoryToolLoan, PurchaseOrder, PurchaseOrderItem, GoodsReceipt, GoodsReceiptItem } = require('../../models');
const AppError = require('../../utils/AppError');
const { registrarAuditoria, registrarTentativaBloqueada } = require('../../engines/audit/auditLog.service');
const { publishMovementRecorded, publishStockLow } = require('./inventoryEvents.service');
const { getMinStockPolicy, resolveMinimumForLocation } = require('./minStockRules.service');
const { getActiveHighValueThreshold } = require('./adjustmentRiskRules.service');
const { getProjectChargedUnitCost } = require('./inventoryCost.service');

// EST-00x (Caderno Marco 7): 7 tipos de movimento. ADJUSTMENT/LOSS/DISPOSAL exigem
// inventory:approve (mesmo padrão de alçada já usado em construction:approve/finance:approve)
// porque alteram saldo sem uma origem física rastreável (recebimento/requisição/devolução).
const MOVEMENT_TYPES = ['IN', 'OUT', 'RETURN', 'TRANSFER', 'ADJUSTMENT', 'LOSS', 'DISPOSAL'];
const APPROVAL_REQUIRED_TYPES = ['ADJUSTMENT', 'LOSS', 'DISPOSAL'];

// EST-002: saldo é sempre derivado de movimentos, nunca digitável diretamente — esta é a
// ÚNICA função do sistema que deve escrever em inventory.stock_balances.
async function applyBalanceDelta(inventoryItemId, locationId, delta, companyId, groupId, allowNegativeStock, transaction) {
  let balance = await InventoryStockBalance.findOne({
    where: { inventoryItemId, locationId, groupId, companyId },
    transaction,
    lock: transaction.LOCK.UPDATE,
  });

  if (!balance) {
    // BUG REAL CORRIGIDO (teste de carga de Estoque/Compras, Marco 7, 19/10/2026): duas
    // entradas simultâneas no PRIMEIRO saldo de um item/local liam "não existe" e a segunda
    // estourava a UNIQUE (item, local) com erro 500. INSERT ... ON CONFLICT DO NOTHING e releitura
    // com FOR UPDATE: quem chega depois espera o lock e soma sobre o saldo já criado.
    await sequelize.query(
      `INSERT INTO inventory.stock_balances (id, group_id, company_id, inventory_item_id, location_id, quantity_on_hand, lock_version, created_at, updated_at)
       VALUES (gen_random_uuid(), :groupId, :companyId, :inventoryItemId, :locationId, 0, 0, NOW(), NOW())
       ON CONFLICT (inventory_item_id, location_id) DO NOTHING`,
      { replacements: { groupId, companyId, inventoryItemId, locationId }, transaction }
    );
    balance = await InventoryStockBalance.findOne({ where: { inventoryItemId, locationId, groupId, companyId }, transaction, lock: transaction.LOCK.UPDATE });
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
async function assertLocationsNotFrozenByCount(locationIds, groupId, companyId, transaction) {
  const ids = [...new Set(locationIds.filter(Boolean))].sort();
  if (ids.length === 0) return;
  await InventoryLocation.findAll({
    where: { id: ids, groupId, companyId },
    attributes: ['id'],
    order: [['id', 'ASC']],
    lock: transaction.LOCK.SHARE,
    transaction,
  });
  const openCount = await InventoryCount.findOne({ where: { locationId: ids, groupId, companyId, status: 'OPEN' }, transaction });
  if (openCount) {
    throw AppError.conflict(
      'Este local está em contagem de inventário físico — movimentações ficam bloqueadas temporariamente até a contagem ser concluída.',
      'INVENTORY_LOCATION_FROZEN_BY_COUNT'
    );
  }
}

function finiteOrNull(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// Revisão Marco 7 (19/10/2026), A1 — EST-011: custo HISTÓRICO do movimento, gravado no fato.
// Regra (ver inventoryCost.service.js para a política de custódia da obra):
//   - entrada por recebimento (IN/RECEIPT): custo da nota (`unitCost` informado pelo recebimento);
//   - material saindo da custódia da obra (RETURN da obra, TRANSFER canteiro → fora): custo pelo
//     qual a obra foi cobrada, limitado ao custo informado (devolução avariada vale menos) —
//     devolver nunca credita mais do que foi cobrado;
//   - demais: custo médio do item NESTE momento.
// Item sem custo conhecido grava null (a obra trata como 0, como antes).
async function resolveMovementCost({ item, movementType, qty, resolvedProjectId, sourceLocationId, destinationLocationId, sourceType, unitCostOverride, groupId, companyId }, transaction) {
  const currentAverage = finiteOrNull(item.averageCost);
  const override = finiteOrNull(unitCostOverride);
  if (override != null && override < 0) {
    throw AppError.badRequest('"unitCost" do movimento não pode ser negativo.', 'INVENTORY_MOVEMENT_VALIDATION');
  }
  let unitCost = currentAverage;

  if (movementType === 'IN' && sourceType === 'RECEIPT' && override != null) {
    unitCost = override;
  } else if (resolvedProjectId && (movementType === 'RETURN' || movementType === 'TRANSFER')) {
    let leavesProject = movementType === 'RETURN';
    if (movementType === 'TRANSFER') {
      const sites = await InventoryLocation.findAll({
        where: { id: [sourceLocationId, destinationLocationId].filter(Boolean), groupId, companyId, locationType: 'PROJECT_SITE', projectId: resolvedProjectId },
        attributes: ['id'],
        transaction,
      });
      const siteIds = new Set(sites.map((l) => l.id));
      leavesProject = siteIds.has(sourceLocationId) && !siteIds.has(destinationLocationId);
    }
    if (leavesProject) {
      const charged = await getProjectChargedUnitCost(resolvedProjectId, item.id, transaction);
      unitCost = charged != null ? charged : currentAverage;
      if (override != null) unitCost = unitCost != null ? Math.min(unitCost, override) : override;
    }
  }

  if (unitCost == null) return { unitCost: null, totalCost: null };
  const roundedUnit = Math.round(unitCost * 1e6) / 1e6;
  return { unitCost: roundedUnit, totalCost: Math.round(qty * unitCost * 100) / 100 };
}

// Revisão Marco 7 (19/10/2026), A6 — origem obrigatória de ADJUSTMENT/DISPOSAL (ver recordMovement).
async function assertAdjustmentOrigin({ groupId, companyId, inventoryItemId, movementType, quantity, sourceType, sourceId, sourceLocationId, destinationLocationId }, actor, transaction) {
  if (movementType === 'ADJUSTMENT' && sourceType === 'COUNT' && sourceId) {
    const count = await InventoryCount.findOne({ where: { id: sourceId, groupId, companyId }, transaction });
    if (count) return;
  }
  if (sourceType === 'ADJUSTMENT_PROPOSAL' && sourceId) {
    const proposal = await InventoryAdjustmentProposal.findOne({ where: { id: sourceId, groupId, companyId }, transaction });
    const matches = proposal
      && proposal.status === 'APPROVED'
      && proposal.movementType === movementType
      && proposal.inventoryItemId === inventoryItemId
      && Number(proposal.quantity) === Number(quantity)
      && (proposal.sourceLocationId || null) === (sourceLocationId || null)
      && (proposal.destinationLocationId || null) === (destinationLocationId || null)
      && proposal.decidedByUserId
      && String(proposal.decidedByUserId) !== String(proposal.proposedByUserId);
    if (matches) return;
  }
  await registrarTentativaBloqueada(
    {
      groupId,
      companyId,
      actorUserId: actor.userId || null,
      action: 'inventory.movement.record',
      entityType: 'InventoryItem',
      entityId: inventoryItemId,
      beforeJson: { movementType, quantity, sourceType: sourceType || null, sourceId: sourceId || null },
      reason: `Tentativa de registrar ${movementType} sem proposta aprovada por outra pessoa (EST-008).`,
    },
    transaction
  );
  throw AppError.badRequest(
    'Ajuste e descarte de estoque não são lançados direto: registre uma proposta de ajuste e peça a aprovação de outra pessoa com permissão.',
    'INVENTORY_ADJUSTMENT_REQUIRES_PROPOSAL'
  );
}


// Revisão Marco 7 (20/10/2026), M7-F03 — a origem do movimento é validada NO SERVIDOR, nunca
// confiada ao cliente. A rota genérica POST /inventory/movements repassa o corpo; sem isto,
// "sourceType=REQUISITION" com sourceId nulo (ou de outra empresa/item) e sem responsável
// virava uma baixa "oficial" sem rastro. Regras:
//   - sem sourceType (ou MANUAL): não pode vir sourceId (não existe origem a apontar);
//   - sourceType desconhecido: recusado;
//   - origem interna (REQUISITION, RECEIPT, TOOL_LOAN, PURCHASE_ORDER_CANCEL): exige sourceId de
//     registro EXISTENTE da MESMA empresa; REQUISITION também exige que o item faça parte da
//     requisição (ou, se for requisição de obra, que a obra seja a mesma) e um responsável;
//   - COUNT, LOSS_CASE e ADJUSTMENT_PROPOSAL continuam validados pelos blocos próprios abaixo.
const KNOWN_SOURCE_TYPES = ['MANUAL', 'RECEIPT', 'REQUISITION', 'TOOL_LOAN', 'ADJUSTMENT', 'COUNT', 'LOSS_CASE', 'ADJUSTMENT_PROPOSAL', 'PURCHASE_ORDER_CANCEL'];
const VALID_SOURCES_BY_MOVEMENT_TYPE = {
  IN: ['RECEIPT', 'REQUISITION', 'MANUAL', 'PURCHASE_ORDER_CANCEL'],
  OUT: ['REQUISITION', 'PURCHASE_ORDER_CANCEL', 'MANUAL'],
  RETURN: ['TOOL_LOAN', 'REQUISITION', 'MANUAL'],
  TRANSFER: ['MANUAL'],
  ADJUSTMENT: ['COUNT', 'ADJUSTMENT_PROPOSAL', 'MANUAL'],
  LOSS: ['LOSS_CASE'],
  DISPOSAL: ['ADJUSTMENT_PROPOSAL', 'MANUAL'],
};

const SOURCE_MODELS = {
  RECEIPT: InventoryReceipt,
  TOOL_LOAN: InventoryToolLoan,
  COUNT: InventoryCount,
  LOSS_CASE: InventoryLossCase,
  ADJUSTMENT_PROPOSAL: InventoryAdjustmentProposal,
};

async function assertMovementSource({ groupId, companyId, inventoryItemId, movementType, sourceType, sourceId, responsiblePersonId, projectId }, transaction) {
  const type = sourceType || 'MANUAL';
  if (!KNOWN_SOURCE_TYPES.includes(type)) {
    throw AppError.badRequest(`Origem do movimento desconhecida ("${sourceType}").`, 'INVENTORY_MOVEMENT_SOURCE_INVALID');
  }

  if (movementType === 'LOSS' && (type !== 'LOSS_CASE' || !sourceId)) {
    throw AppError.badRequest(
      'Um movimento de perda só pode ser registrado a partir de um caso de perda já aprovado — abra o caso em "Perdas & Extravios" primeiro.',
      'INVENTORY_MOVEMENT_LOSS_REQUIRES_LOSS_CASE'
    );
  }

  // Validação da matriz de combinações válidas entre movementType e sourceType
  if (movementType) {
    const allowed = VALID_SOURCES_BY_MOVEMENT_TYPE[movementType] || ['MANUAL'];
    if (!allowed.includes(type)) {
      throw AppError.badRequest(
        `A origem "${type}" não é permitida para movimentações do tipo "${movementType}".`,
        'INVENTORY_MOVEMENT_SOURCE_INVALID'
      );
    }
  }

  if (type === 'MANUAL') {
    if (sourceId) throw AppError.badRequest('Movimento manual não pode apontar uma origem ("sourceId").', 'INVENTORY_MOVEMENT_SOURCE_INVALID');
    if (movementType === 'OUT' && !responsiblePersonId) {
      throw AppError.badRequest('Saída manual de estoque exige informar o responsável pela retirada.', 'INVENTORY_MOVEMENT_RESPONSIBLE_REQUIRED');
    }
    return;
  }

  if (!sourceId) {
    throw AppError.badRequest(`Origem "${type}" exige o identificador do registro de origem ("sourceId").`, 'INVENTORY_MOVEMENT_SOURCE_REQUIRED');
  }

  const notFound = () => AppError.badRequest('A origem informada não existe nesta empresa.', 'INVENTORY_MOVEMENT_SOURCE_INVALID');

  if (type === 'REQUISITION') {
    const req = await InventoryRequisition.findOne({ where: { id: sourceId, groupId, companyId }, transaction });
    if (req) {
      const line = await InventoryRequisitionItem.findOne({ where: { requisitionId: req.id, inventoryItemId, groupId, companyId }, transaction });
      if (!line) throw AppError.badRequest('O item deste movimento não faz parte da requisição de origem.', 'INVENTORY_MOVEMENT_SOURCE_ITEM_MISMATCH');
      if (!responsiblePersonId) throw AppError.badRequest('Movimento de requisição exige o responsável pela retirada ("responsiblePersonId").', 'INVENTORY_MOVEMENT_RESPONSIBLE_REQUIRED');
      return;
    }
    const mr = await MaterialRequest.findOne({ where: { id: sourceId, groupId, companyId }, transaction });
    if (!mr) throw notFound();
    // Requisição de obra (Construção): o responsável rastreável é quem a solicitou (requestedByUserId).
    if (!responsiblePersonId && !mr.requestedByUserId) {
      throw AppError.badRequest('Movimento de requisição exige o responsável pela retirada ("responsiblePersonId").', 'INVENTORY_MOVEMENT_RESPONSIBLE_REQUIRED');
    }
    if (projectId && mr.projectId && mr.projectId !== projectId) {
      throw AppError.badRequest('A obra do movimento não é a da requisição de origem.', 'INVENTORY_MOVEMENT_SOURCE_PROJECT_MISMATCH');
    }
    return;
  }

  if (type === 'LOSS_CASE') {
    const lc = await InventoryLossCase.findOne({ where: { id: sourceId, groupId, companyId }, transaction });
    if (!lc) throw notFound();
    if (lc.inventoryItemId !== inventoryItemId) {
      throw AppError.badRequest('O caso de perda não pertence ao item deste movimento.', 'INVENTORY_MOVEMENT_SOURCE_ITEM_MISMATCH');
    }
    return;
  }

  if (type === 'ADJUSTMENT_PROPOSAL') {
    const prop = await InventoryAdjustmentProposal.findOne({ where: { id: sourceId, groupId, companyId }, transaction });
    if (!prop) throw notFound();
    if (prop.inventoryItemId !== inventoryItemId) {
      throw AppError.badRequest('A proposta de ajuste não pertence ao item deste movimento.', 'INVENTORY_MOVEMENT_SOURCE_ITEM_MISMATCH');
    }
    return;
  }

  if (type === 'PURCHASE_ORDER_CANCEL') {
    if (!responsiblePersonId) {
      throw AppError.badRequest('Cancelamento de compra com estorno de estoque exige responsável identificado.', 'INVENTORY_MOVEMENT_RESPONSIBLE_REQUIRED');
    }
    const po = await PurchaseOrder.findOne({ where: { id: sourceId, groupId, companyId }, transaction });
    if (!po) throw notFound();

    // Validar lastro real da compensação:
    // O pedido precisa ter recebimento confirmado contendo o item informado.
    const receipts = await GoodsReceipt.findAll({
      where: { purchaseOrderId: po.id, groupId, companyId, status: 'CONFIRMED' },
      attributes: ['id'],
      transaction,
    });
    if (!receipts.length) {
      throw AppError.badRequest(
        'Pedido de compra não possui recebimento confirmado deste item para compensação de cancelamento.',
        'INVENTORY_MOVEMENT_SOURCE_INVALID'
      );
    }
    const poItems = await PurchaseOrderItem.findAll({
      where: { purchaseOrderId: po.id, inventoryItemId, groupId, companyId },
      attributes: ['id'],
      transaction,
    });
    if (!poItems.length) {
      throw AppError.badRequest(
        'O item informado não faz parte do pedido de compra de origem.',
        'INVENTORY_MOVEMENT_SOURCE_ITEM_MISMATCH'
      );
    }
    const receiptIds = receipts.map((r) => r.id);
    const poItemIds = poItems.map((p) => p.id);
    const grItems = await GoodsReceiptItem.findAll({
      where: {
        goodsReceiptId: receiptIds,
        purchaseOrderItemId: poItemIds,
        groupId,
        companyId,
      },
      attributes: ['id'],
      transaction,
    });
    if (!grItems.length) {
      throw AppError.badRequest(
        'O item informado não possui recebimento confirmado neste pedido de compra.',
        'INVENTORY_MOVEMENT_SOURCE_INVALID'
      );
    }
    return;
  }

  const Model = SOURCE_MODELS[type];
  if (Model) {
    const found = await Model.findOne({ where: { id: sourceId, groupId, companyId }, attributes: ['id'], transaction });
    if (!found) throw notFound();
  }
}

async function recordMovement(payload, actor, transaction) {
  const {
    groupId,
    companyId,
    inventoryItemId,
    projectId,
    stageId,
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
    unitCost: unitCostOverride,
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

  const item = await InventoryItem.findOne({ where: { id: inventoryItemId, groupId, companyId }, transaction });
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
    throw AppError.badRequest('Transferência exige o local de origem e o local de destino.', 'INVENTORY_MOVEMENT_VALIDATION');
  }
  if (movementType === 'ADJUSTMENT' && !sourceLocationId && !destinationLocationId) {
    throw AppError.badRequest('Informe o local de origem (para diminuir o saldo) ou de destino (para aumentar o saldo) do ajuste.', 'INVENTORY_MOVEMENT_VALIDATION');
  }
  // BUG GRAVE REAL CORRIGIDO (auditoria Marco 7, rodada "check"): preencher origem E destino num
  // Ajuste passava pela checagem acima (nenhum dos dois estava vazio) e caía no ramo abaixo que só
  // credita o destino — a origem nunca era debitada, criando saldo do nada (o histórico mostrava
  // "de X para Y" como se fosse transferência, mas só o destino de fato mudava). Ajuste corrige o
  // saldo de UM local por vez; mover entre dois locais é Transferência, nunca Ajuste.
  if (movementType === 'ADJUSTMENT' && sourceLocationId && destinationLocationId) {
    throw AppError.badRequest(
      'Um ajuste corrige o saldo de um único local. Para mover quantidade entre dois locais, use "Transferência".',
      'INVENTORY_MOVEMENT_VALIDATION'
    );
  }
  // EST-008: ajuste/perda/descarte exigem motivo (evidência é recomendada, mas só obrigatória
  // quando a política da empresa exigir — isso é regra de negócio do Motor de Regras, fora de
  // código fixo; aqui garantimos o mínimo "sempre obrigatório" do Caderno, que é o motivo).
  // BUG REAL CORRIGIDO (auditoria Marco 7, EST-TS-07, 2026-10-07): "   " (só espaços) passava
  // no `!reason`, gravando um ajuste/perda/descarte no ledger imutável sem motivo de verdade.
  if (APPROVAL_REQUIRED_TYPES.includes(movementType) && (!reason || !String(reason).trim())) {
    throw AppError.badRequest(`Movimento "${movementType}" exige "reason" (motivo).`, 'INVENTORY_MOVEMENT_REASON_REQUIRED');
  }
  // GAP REAL CORRIGIDO (auditoria Marco 7, Caderno §6 EST-TS-12, 2026-10-08): "evento repetido
  // não pode criar segunda obrigação" já era garantido POR CONSTRUÇÃO nos fluxos automatizados
  // (recebimento/requisição geram a idempotencyKey internamente antes de chamar recordMovement),
  // mas o endpoint genérico de movimento manual deixava idempotencyKey opcional — um ADJUSTMENT/
  // LOSS/DISPOSAL disparado manualmente (os mesmos tipos reexecutáveis que já exigem reason/
  // aprovação acima) podia ser reenviado (retry, duplo clique) sem key e criar uma segunda
  // obrigação de verdade. IN/OUT/TRANSFER continuam sem exigência aqui porque são chamados
  // internamente por outros services que já constroem a key (ex.: receipts.service.js linha
  // ~157: `receipt:${receipt.id}:item:${line.id}`) — exigir aqui quebraria esses fluxos.
  if (APPROVAL_REQUIRED_TYPES.includes(movementType) && !idempotencyKey) {
    throw AppError.badRequest(
      'Não foi possível registrar o movimento — tente novamente em alguns instantes.',
      'INVENTORY_MOVEMENT_IDEMPOTENCY_KEY_REQUIRED'
    );
  }
  // GAP REAL CORRIGIDO (reauditoria externa Nayara, 3ª rodada, 2026-10-08; EST-008: "...
  // evidência... conforme valor/risco"): motivo e aprovação (canApprove, acima) já eram sempre
  // obrigatórios pros 3 tipos — faltava o eixo "valor": acima de um limiar configurável
  // (REG-EST-002, Motor de Regras — ver adjustmentRiskRules.service.js), evidência deixa de
  // ser opcional e passa a ser obrigatória, igual o "ajuste de alto valor" exige comprovação
  // visual, não só uma linha de texto.
  // BUG REAL CORRIGIDO (reauditoria adversarial da própria correção EST-008, 2026-10-08): item
  // nunca recebido formalmente (averageCost null/0, ex.: cadastrado direto ou só movimentado via
  // ADJUSTMENT) fazia estimatedValue=0 e pulava o limiar de valor/risco INTEIRO, não importa a
  // quantidade — um ajuste de 100.000 unidades de um item de custo desconhecido passava sem
  // evidência nenhuma. Custo desconhecido é RISCO, não ausência de risco: trata averageCost
  // null/0 como "valor não determinável" e aplica o limiar por QUANTIDADE (mesma ordem de
  // grandeza do limiar de valor padrão, na ausência de custo) em vez de pular a checagem.
  // GAP GRAVE CORRIGIDO (auditoria RLS/multi-tenant, 2026-10-08): `evidenceFileId` nunca era
  // validado contra a tabela File — qualquer string (UUID inventado, ou de OUTRA empresa) era
  // aceita como "evidência válida" pro REG-EST-002, esvaziando a exigência de comprovação visual.
  // Mesmo padrão já usado em `lossCases.service.js#openLossCase` (File.findOne/findAll com
  // companyId no where): se o File não existe (ou não pertence a este tenant), trata como se
  // evidência não tivesse sido fornecida — reaproveita a mesma validação de alto valor abaixo.
  let evidenceFile = null;
  if (evidenceFileId) {
    evidenceFile = await File.findOne({ where: { id: evidenceFileId, groupId, companyId }, transaction });
  }
  if (APPROVAL_REQUIRED_TYPES.includes(movementType) && !evidenceFile) {
    const hasKnownCost = item.averageCost != null && Number(item.averageCost) > 0;
    const estimatedValue = qty * Number(item.averageCost || 0);
    const { highValueThreshold } = await getActiveHighValueThreshold(groupId, companyId, transaction, actor.userId);
    const unknownCostHighQuantity = !hasKnownCost && qty >= highValueThreshold;
    if ((hasKnownCost && estimatedValue >= highValueThreshold) || unknownCostHighQuantity) {
      const detail = hasKnownCost
        ? `de valor estimado R$ ${estimatedValue.toFixed(2)} está acima do limite de R$ ${highValueThreshold.toFixed(2)}`
        : `de quantidade ${qty} (custo médio do item desconhecido/zerado) está acima do limite de ${highValueThreshold}`;
      await registrarTentativaBloqueada(
        {
          groupId,
          companyId,
          actorUserId: actor.userId || null,
          action: 'inventory.movement.record',
          entityType: 'InventoryItem',
          entityId: item.id,
          beforeJson: { item: item.toJSON(), movementType, quantity: qty, estimatedValue, highValueThreshold },
          reason: 'Tentativa de registrar movimento de alto valor sem evidência (REG-EST-002).',
        },
        transaction
      );
      throw AppError.badRequest(
        `Movimento "${movementType}" ${detail} (REG-EST-002) — exige "evidenceFileId".`,
        'INVENTORY_MOVEMENT_EVIDENCE_REQUIRED_HIGH_VALUE'
      );
    }
  }
  // EST-006: saída de ferramenta/ativo (item_type TOOL/ASSET) exige responsável.
  if ((movementType === 'OUT' || movementType === 'TRANSFER') && ['TOOL', 'ASSET'].includes(item.itemType) && !responsiblePersonId) {
    throw AppError.badRequest(`Movimento "${movementType}" de ferramenta/ativo exige "responsiblePersonId".`, 'INVENTORY_MOVEMENT_VALIDATION');
  }
  // BUG REAL CORRIGIDO (auditoria Nayara, Marco 7, F17): uma "Saída" manual pela tela de
  // Movimentos passava sem obra, responsável ou motivo — exatamente o risco "Baixa sem retirada"
  // do Caderno (seção 13, "QR/responsável/evidência conforme risco"). Fluxos automatizados
  // (requisição, devolução de ferramenta etc.) já chegam aqui com `sourceType` preenchido e
  // controlado pelo próprio fluxo de origem — essa exigência vale só pra saída manual genuína
  // (sem sourceType, ou MANUAL), que é onde a baixa sem controle de fato acontecia.
  if (movementType === 'OUT' && !responsiblePersonId) {
    if (sourceType !== 'REQUISITION' || !sourceId) {
      throw AppError.badRequest('Saída de estoque exige informar o responsável pela retirada.', 'INVENTORY_MOVEMENT_RESPONSIBLE_REQUIRED');
    }
  }
  // Revisão Marco 7 (20/10/2026), M7-F03 — origem e responsável validados no servidor.
  await assertMovementSource({ groupId, companyId, inventoryItemId, movementType, sourceType, sourceId, responsiblePersonId, projectId }, transaction);
  if (responsiblePersonId) {
    const person = await Person.findOne({ where: { id: responsiblePersonId, groupId, companyId }, attributes: ['id'], transaction });
    if (!person) throw AppError.badRequest('O responsável informado não existe nesta empresa.', 'INVENTORY_MOVEMENT_RESPONSIBLE_INVALID');
  }
  // Revisão Marco 7 (19/10/2026), A6 — EST-008 (checado depois de motivo/chave/evidência, para
  // que esses erros de preenchimento continuem aparecendo primeiro): quem tinha inventory:approve registrava e
  // "aprovava" o próprio ADJUSTMENT/DISPOSAL manual (a permissão era a única barreira). Agora o
  // ledger só aceita esses dois tipos vindos de um fluxo com segregação já verificada:
  //   - COUNT: ajuste de inventário físico (counts.service.js#applyAdjustment já impede quem abriu
  //     a contagem de aprovar o próprio ajuste);
  //   - ADJUSTMENT_PROPOSAL: proposta aprovada por OUTRA pessoa (proposeAdjustment/
  //     decideAdjustmentProposal abaixo), conferida aqui de novo contra o banco.
  if (['ADJUSTMENT', 'DISPOSAL'].includes(movementType)) {
    await assertAdjustmentOrigin({ groupId, companyId, inventoryItemId, movementType, quantity, sourceType, sourceId, sourceLocationId, destinationLocationId }, actor, transaction);
  }
  // GAP REAL CORRIGIDO (auditoria EST-010, 2026-10-08): o endpoint genérico de movimentos
  // aceitava "movementType: LOSS" direto (com motivo/aprovação/evidência por valor já exigidos
  // acima), mas sem NENHUM vínculo obrigatório com um InventoryLossCase — permitindo registrar
  // perda/quebra/extravio sem nunca passar pela investigação/decisão humana que
  // lossCases.service.js implementa (abertura -> decisão -> só então o movimento). Exige que o
  // LOSS venha de um loss_case já APROVADO deste tenant, com o mesmo inventoryItemId.
  // DISPOSAL (baixa deliberada de item, não perda) continua sem essa exigência de propósito —
  // o contrato (EST-010) é especificamente sobre perda/quebra/extravio.
  if (movementType === 'LOSS') {
    if (sourceType !== 'LOSS_CASE' || !sourceId) {
      await registrarTentativaBloqueada(
        {
          groupId,
          companyId,
          actorUserId: actor.userId || null,
          action: 'inventory.movement.record',
          entityType: 'InventoryItem',
          entityId: item.id,
          beforeJson: { item: item.toJSON(), movementType, quantity: qty, sourceType, sourceId },
          reason: 'Tentativa de registrar movimento LOSS sem vínculo com caso de perda (EST-010).',
        },
        transaction
      );
      throw AppError.badRequest(
        'Um movimento de perda só pode ser registrado a partir de um caso de perda já aprovado — abra o caso em "Perdas & Extravios" primeiro.',
        'INVENTORY_MOVEMENT_LOSS_REQUIRES_LOSS_CASE'
      );
    }
    const lossCase = await InventoryLossCase.findOne({ where: { id: sourceId, groupId, companyId }, transaction });
    if (!lossCase || lossCase.status !== 'APPROVED' || lossCase.inventoryItemId !== inventoryItemId) {
      await registrarTentativaBloqueada(
        {
          groupId,
          companyId,
          actorUserId: actor.userId || null,
          action: 'inventory.movement.record',
          entityType: 'InventoryItem',
          entityId: item.id,
          beforeJson: { item: item.toJSON(), movementType, quantity: qty, sourceId, lossCase: lossCase ? lossCase.toJSON() : null },
          reason: 'Tentativa de registrar movimento LOSS com caso de perda inválido/não aprovado/de outro item (EST-010).',
        },
        transaction
      );
      throw AppError.badRequest(
        'O caso de perda informado não existe, não pertence a este item, ou ainda não foi aprovado.',
        'INVENTORY_MOVEMENT_LOSS_REQUIRES_LOSS_CASE'
      );
    }
  }
  // EST-004: material atribuído à obra (entra/sai de um local PROJECT_SITE) precisa de projectId.
  // BUG REAL CORRIGIDO (auditoria Nayara, Marco 7, F2): o formulário de movimento não tem (nem
  // deveria ter) campo de obra — um canteiro pertence a UMA obra fixa, decidida no cadastro do
  // local (items.service.js#createLocation já exige isso). Em vez de exigir "projectId" de novo
  // aqui, deriva automaticamente da(s) obra(s) do(s) local(is) de obra tocados pelo movimento.
  const touchedLocationIds = [sourceLocationId, destinationLocationId].filter(Boolean);
  let resolvedProjectId = projectId || null;
  if (touchedLocationIds.length > 0) {
    const siteLocations = await InventoryLocation.findAll({
      where: { id: touchedLocationIds, groupId, companyId, locationType: 'PROJECT_SITE' },
      transaction,
    });
    if (siteLocations.length > 0) {
      const projectIdsFromSites = [...new Set(siteLocations.map((l) => l.projectId).filter(Boolean))];
      // Revisão Marco 7 (20/10/2026), M7-F01 — um projectId explícito só vale se for a obra de
      // TODOS os canteiros tocados (fail-closed: o cliente não escolhe a obra do custo).
      if (resolvedProjectId && projectIdsFromSites.some((pid) => pid !== resolvedProjectId)) {
        throw AppError.badRequest('A obra informada não é a obra do canteiro deste movimento.', 'INVENTORY_MOVEMENT_PROJECT_MISMATCH');
      }
      if (!resolvedProjectId) {
        if (projectIdsFromSites.length === 1) {
          resolvedProjectId = projectIdsFromSites[0];
        } else if (projectIdsFromSites.length > 1) {
          // TRANSFER entre dois canteiros de obras DIFERENTES — caso raro, não dá pra
          // escolher uma obra sozinho, exige que o chamador informe qual prevalece.
          throw AppError.badRequest('Movimento entre locais de obras diferentes exige "projectId" explícito.', 'INVENTORY_MOVEMENT_PROJECT_AMBIGUOUS');
        } else {
          // Local PROJECT_SITE sem obra vinculada (dado legado anterior à exigência em
          // createLocation) — fail closed, igual ao comportamento anterior.
          throw AppError.badRequest('Este local é um canteiro de obra, mas não tem nenhuma obra vinculada no cadastro — edite o local e vincule a obra antes de movimentar.', 'INVENTORY_MOVEMENT_PROJECT_REQUIRED');
        }
      }
    }
  }

  // Revisão Marco 7 (19/10/2026), A7 — EST-004 ("Material consumido precisa de
  // project_id/stage_id quando atribuído à obra") e Caderno §5 ("OUT vincula project_id/stage_id
  // e responsável"): a etapa era opcional. Toda SAÍDA (OUT) atribuída a uma obra — seja a
  // entrega da requisição saindo do almoxarifado, seja o consumo saindo do canteiro — exige a
  // etapa, e a etapa precisa ser desta obra.
  if (resolvedProjectId) {
    const project = await Project.findOne({ where: { id: resolvedProjectId, groupId, companyId }, attributes: ['id'], transaction });
    if (!project) throw AppError.badRequest('A obra informada não existe nesta empresa.', 'INVENTORY_MOVEMENT_PROJECT_INVALID');
  }
  // M7-F02 — etapa informada (em QUALQUER tipo de movimento) precisa ser da obra do movimento.
  if (stageId && !resolvedProjectId) {
    throw AppError.badRequest('Etapa informada sem obra: informe a obra ou um canteiro vinculado a ela.', 'INVENTORY_MOVEMENT_STAGE_INVALID');
  }
  if (stageId && movementType !== 'OUT') {
    const stg = await ProjectStage.findOne({ where: { id: stageId, projectId: resolvedProjectId }, transaction });
    if (!stg) throw AppError.badRequest('A etapa informada não pertence à obra deste movimento.', 'INVENTORY_MOVEMENT_STAGE_INVALID');
  }
  if (movementType === 'OUT' && resolvedProjectId && sourceType !== 'PURCHASE_ORDER_CANCEL') {
    if (!stageId) {
      throw AppError.badRequest('Saída de material para a obra exige a etapa ("stageId") — informe em qual etapa o material foi usado.', 'INVENTORY_MOVEMENT_STAGE_REQUIRED');
    }
    const stage = await ProjectStage.findOne({ where: { id: stageId, projectId: resolvedProjectId }, transaction });
    if (!stage) {
      throw AppError.badRequest('A etapa informada não pertence à obra deste movimento.', 'INVENTORY_MOVEMENT_STAGE_INVALID');
    }
  } else if (movementType === 'OUT' && resolvedProjectId && stageId) {
    const stage = await ProjectStage.findOne({ where: { id: stageId, projectId: resolvedProjectId }, transaction });
    if (!stage) {
      throw AppError.badRequest('A etapa informada não pertence à obra deste movimento.', 'INVENTORY_MOVEMENT_STAGE_INVALID');
    }
  }

  // EST-00x: idempotência — reenvio do mesmo payload (ex.: retry de rede) não duplica o movimento.
  if (idempotencyKey) {
    // BUG REAL CORRIGIDO (teste de carga de Estoque/Compras, Marco 7, 19/10/2026): dois envios
    // SIMULTÂNEOS da mesma chave liam "não existe" ao mesmo tempo e o segundo estourava a UNIQUE
    // (company_id, idempotency_key) com erro 500 em vez de devolver o movimento. Trava consultiva
    // da transação por (empresa, chave): o segundo espera o commit do primeiro e o encontra.
    await sequelize.query('SELECT pg_advisory_xact_lock(hashtextextended(:k, 0))', { replacements: { k: `inventory-movement:${companyId}:${idempotencyKey}` }, transaction });
    const existing = await InventoryMovement.findOne({ where: { companyId, idempotencyKey }, transaction });
    if (existing) return existing;
  }

  // Caderno §10: freeze lógico durante inventário físico (ver assertLocationsNotFrozenByCount).
  // Depois do retorno idempotente acima: reenvio de um movimento JÁ gravado antes da contagem
  // abrir não é um movimento novo, então devolve o original em vez de falhar.
  await assertLocationsNotFrozenByCount(touchedLocationIds, groupId, companyId, transaction);

  const { unitCost, totalCost } = await resolveMovementCost(
    { item, movementType, qty, resolvedProjectId, sourceLocationId, destinationLocationId, sourceType, unitCostOverride, groupId, companyId },
    transaction
  );

  const movement = await InventoryMovement.create(
    {
      groupId,
      companyId,
      inventoryItemId,
      projectId: resolvedProjectId,
      stageId: stageId || null,
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
      evidenceFileId: evidenceFile ? evidenceFile.id : null,
      reason: reason || null,
      unitCost,
      totalCost,
      costSource: 'RECORDED',
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
      afterJson: { movementType, quantity: qty, inventoryItemId, sourceLocationId, destinationLocationId, projectId: resolvedProjectId, stageId: stageId || null, unitCost, totalCost },
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

async function getBalance(inventoryItemId, locationId, groupId, companyId, transaction) {
  const balance = await InventoryStockBalance.findOne({ where: { inventoryItemId, locationId, groupId, companyId }, transaction });
  return balance ? Number(balance.quantityOnHand) : 0;
}

// BUG REAL CORRIGIDO (auditoria Nayara, Marco 7, F3): não existia NENHUM jeito de ver o
// histórico (ledger) de movimentações — a tela "Movimentos" só mostrava o saldo atual agregado,
// sem quem moveu o quê, quando e por quê. A tabela já grava tudo (append-only, ver model); só
// faltava a listagem. Filtros opcionais por item/local/tipo, mais recente primeiro.
async function listMovements(filters, groupId, companyId, transaction) {
  const { inventoryItemId, locationId, movementType, limit } = filters || {};
  const where = { groupId, companyId };
  if (inventoryItemId) where.inventoryItemId = inventoryItemId;
  if (movementType) where.movementType = movementType;
  if (locationId) {
    const { Op } = require('sequelize');
    where[Op.or] = [{ sourceLocationId: locationId }, { destinationLocationId: locationId }];
  }
  return InventoryMovement.findAll({
    where,
    include: [
      { model: InventoryItem, as: 'inventoryItem', attributes: ['id', 'name', 'sku'] },
      { model: InventoryLocation, as: 'sourceLocation', attributes: ['id', 'name'] },
      { model: InventoryLocation, as: 'destinationLocation', attributes: ['id', 'name'] },
      { model: User, as: 'movedByUser', attributes: ['id', 'name'] },
      { model: Person, as: 'responsiblePerson', attributes: ['id', 'legalName'] },
      { model: ProjectStage, as: 'stage', attributes: ['id', 'name'] },
    ],
    order: [['moved_at', 'DESC']],
    limit: Math.min(Number(limit) || 100, 500),
    transaction,
  });
}

async function listBalancesByItem(inventoryItemId, groupId, companyId, transaction) {
  return InventoryStockBalance.findAll({
    where: { inventoryItemId, groupId, companyId },
    include: [{ model: InventoryLocation, as: 'location' }],
    order: [['location_id', 'ASC']],
    limit: 1500,
    transaction,
  });
}

// =============================================================================================
// Revisão Marco 7 (19/10/2026), A6 — EST-008: proposta de ajuste/descarte manual.
// Quem propõe (inventory:create) não mexe no saldo; outra pessoa com inventory:approve decide.
// A aprovação grava o movimento pelo mesmo recordMovement (motivo, evidência por valor, freeze
// de contagem, saldo negativo e custo histórico continuam valendo), com sourceType
// ADJUSTMENT_PROPOSAL — e recordMovement confere de novo, no banco, que a proposta foi aprovada
// por alguém diferente de quem a propôs (CHECK de segregação também na tabela).
// =============================================================================================
const PROPOSAL_TYPES = ['ADJUSTMENT', 'DISPOSAL'];

async function proposeAdjustment(payload, actor, transaction) {
  const { groupId, companyId, inventoryItemId, movementType, quantity, sourceLocationId, destinationLocationId, reason, evidenceFileId, idempotencyKey } = payload || {};
  if (!actor?.userId) {
    throw AppError.badRequest('Proposta de ajuste exige um usuário autenticado.', 'INVENTORY_MOVEMENT_ACTOR_REQUIRED');
  }
  if (!groupId || !companyId || !inventoryItemId) {
    throw AppError.badRequest('Informe o item do ajuste.', 'INVENTORY_ADJUSTMENT_VALIDATION');
  }
  if (!PROPOSAL_TYPES.includes(movementType)) {
    throw AppError.badRequest('A proposta precisa ser de "ADJUSTMENT" (ajuste) ou "DISPOSAL" (descarte).', 'INVENTORY_ADJUSTMENT_VALIDATION');
  }
  const qty = Number(quantity);
  if (!Number.isFinite(qty) || qty <= 0) {
    throw AppError.badRequest('"quantity" precisa ser um número maior que zero.', 'INVENTORY_ADJUSTMENT_VALIDATION');
  }
  if (!reason || !String(reason).trim()) {
    throw AppError.badRequest(`Movimento "${movementType}" exige "reason" (motivo).`, 'INVENTORY_MOVEMENT_REASON_REQUIRED');
  }
  if (!idempotencyKey) {
    throw AppError.badRequest('Não foi possível registrar a proposta — tente novamente em alguns instantes.', 'INVENTORY_MOVEMENT_IDEMPOTENCY_KEY_REQUIRED');
  }
  if (movementType === 'ADJUSTMENT' && Boolean(sourceLocationId) === Boolean(destinationLocationId)) {
    throw AppError.badRequest('Um ajuste corrige o saldo de um único local: informe a origem (para diminuir) OU o destino (para aumentar).', 'INVENTORY_MOVEMENT_VALIDATION');
  }
  if (movementType === 'DISPOSAL' && (!sourceLocationId || destinationLocationId)) {
    throw AppError.badRequest('Descarte exige apenas o local de origem.', 'INVENTORY_MOVEMENT_VALIDATION');
  }

  await sequelize.query('SELECT pg_advisory_xact_lock(hashtextextended(:k, 0))', { replacements: { k: `inventory-adjustment-proposal:${companyId}:${idempotencyKey}` }, transaction });
  const existing = await InventoryAdjustmentProposal.findOne({ where: { groupId, companyId, idempotencyKey }, transaction });
  if (existing) return existing;

  const item = await InventoryItem.findOne({ where: { id: inventoryItemId, groupId, companyId }, transaction });
  if (!item) throw AppError.notFound('Item de estoque não encontrado.', 'INVENTORY_ITEM_NOT_FOUND');
  if (item.itemType === 'SERVICE_ITEM') {
    throw AppError.badRequest('Item do tipo "SERVICE_ITEM" não movimenta estoque (não possui saldo físico).', 'INVENTORY_MOVEMENT_SERVICE_ITEM_FORBIDDEN');
  }
  const locationId = sourceLocationId || destinationLocationId;
  const location = await InventoryLocation.findOne({ where: { id: locationId, groupId, companyId }, transaction });
  if (!location) throw AppError.notFound('Local de estoque não encontrado.', 'INVENTORY_LOCATION_NOT_FOUND');
  if (location.locationType === 'PROJECT_SITE' && !location.projectId) {
    throw AppError.badRequest('Este local é um canteiro de obra, mas não tem nenhuma obra vinculada no cadastro — edite o local e vincule a obra antes de movimentar.', 'INVENTORY_MOVEMENT_PROJECT_REQUIRED');
  }

  let evidenceFile = null;
  if (evidenceFileId) evidenceFile = await File.findOne({ where: { id: evidenceFileId, groupId, companyId }, transaction });
  const hasKnownCost = item.averageCost != null && Number(item.averageCost) > 0;
  const estimatedValue = hasKnownCost ? Math.round(qty * Number(item.averageCost) * 100) / 100 : null;
  if (!evidenceFile) {
    const { highValueThreshold } = await getActiveHighValueThreshold(groupId, companyId, transaction, actor.userId);
    if ((hasKnownCost && estimatedValue >= highValueThreshold) || (!hasKnownCost && qty >= highValueThreshold)) {
      throw AppError.badRequest(
        hasKnownCost
          ? `Ajuste de valor estimado R$ ${estimatedValue.toFixed(2)} está acima do limite de R$ ${Number(highValueThreshold).toFixed(2)} (REG-EST-002) — anexe uma evidência.`
          : `Ajuste de quantidade ${qty} (custo do item desconhecido) está acima do limite de ${highValueThreshold} (REG-EST-002) — anexe uma evidência.`,
        'INVENTORY_MOVEMENT_EVIDENCE_REQUIRED_HIGH_VALUE'
      );
    }
  }

  const proposal = await InventoryAdjustmentProposal.create(
    {
      groupId,
      companyId,
      inventoryItemId,
      movementType,
      quantity: qty,
      sourceLocationId: sourceLocationId || null,
      destinationLocationId: destinationLocationId || null,
      projectId: location.locationType === 'PROJECT_SITE' ? location.projectId : null,
      reason: String(reason).trim(),
      evidenceFileId: evidenceFile ? evidenceFile.id : null,
      estimatedValue,
      idempotencyKey,
      status: 'PENDING',
      proposedByUserId: actor.userId,
    },
    { transaction }
  );
  await registrarAuditoria(
    { groupId, companyId, actorUserId: actor.userId, action: 'INVENTORY_ADJUSTMENT_PROPOSED', entityType: 'InventoryAdjustmentProposal', entityId: proposal.id, afterJson: proposal.toJSON(), reason: `Proposta de ${movementType === 'DISPOSAL' ? 'descarte' : 'ajuste'} de estoque registrada — aguarda aprovação de outra pessoa.` },
    transaction
  );
  return proposal;
}

async function decideAdjustmentProposal(proposalId, groupId, companyId, decision, actor, transaction, { decisionNote } = {}) {
  if (!['APPROVED', 'REJECTED'].includes(decision)) {
    throw AppError.badRequest('"decision" precisa ser "APPROVED" ou "REJECTED".', 'INVENTORY_ADJUSTMENT_VALIDATION');
  }
  if (!actor?.canApprove) {
    throw AppError.forbidden('Decidir um ajuste de estoque exige a permissão inventory:approve.', 'INVENTORY_MOVEMENT_APPROVAL_REQUIRED');
  }
  const proposal = await InventoryAdjustmentProposal.findOne({ where: { id: proposalId, groupId, companyId }, transaction, lock: transaction.LOCK.UPDATE });
  if (!proposal) throw AppError.notFound('Proposta de ajuste não encontrada.', 'INVENTORY_ADJUSTMENT_NOT_FOUND');
  if (proposal.status !== 'PENDING') {
    throw AppError.conflict(`Esta proposta já foi decidida (${proposal.status === 'APPROVED' ? 'aprovada' : 'rejeitada'}).`, 'INVENTORY_ADJUSTMENT_INVALID_TRANSITION');
  }
  if (String(proposal.proposedByUserId) === String(actor.userId)) {
    await registrarTentativaBloqueada(
      { groupId, companyId, actorUserId: actor.userId, action: 'inventory.adjustment_proposal.decide', entityType: 'InventoryAdjustmentProposal', entityId: proposal.id, beforeJson: proposal.toJSON(), reason: 'Quem propôs o ajuste tentou aprová-lo/rejeitá-lo (EST-008).' },
      transaction
    );
    throw AppError.forbidden('Quem propôs este ajuste não pode aprová-lo/rejeitá-lo — peça a decisão de outra pessoa com permissão.', 'INVENTORY_ADJUSTMENT_SELF_APPROVAL_BLOCKED');
  }
  const note = decisionNote != null && String(decisionNote).trim() ? String(decisionNote).trim().slice(0, 500) : null;
  const before = { status: proposal.status, decidedByUserId: null };
  proposal.status = decision;
  proposal.decidedByUserId = actor.userId;
  proposal.decidedAt = new Date();
  proposal.decisionNote = note;
  await proposal.save({ transaction });

  if (decision === 'APPROVED') {
    const movement = await recordMovement(
      {
        groupId,
        companyId,
        inventoryItemId: proposal.inventoryItemId,
        movementType: proposal.movementType,
        quantity: proposal.quantity,
        sourceLocationId: proposal.sourceLocationId || undefined,
        destinationLocationId: proposal.destinationLocationId || undefined,
        sourceType: 'ADJUSTMENT_PROPOSAL',
        sourceId: proposal.id,
        idempotencyKey: `adjustment-proposal:${proposal.id}`,
        evidenceFileId: proposal.evidenceFileId || undefined,
        reason: proposal.reason,
      },
      actor,
      transaction
    );
    proposal.resultingMovementId = movement.id;
    await proposal.save({ transaction });
  }

  await registrarAuditoria(
    {
      groupId,
      companyId,
      actorUserId: actor.userId,
      action: 'INVENTORY_ADJUSTMENT_DECIDED',
      entityType: 'InventoryAdjustmentProposal',
      entityId: proposal.id,
      beforeJson: before,
      afterJson: { status: proposal.status, decidedByUserId: proposal.decidedByUserId, proposedByUserId: proposal.proposedByUserId, resultingMovementId: proposal.resultingMovementId, decisionNote: note },
      reason: decision === 'APPROVED' ? 'Proposta de ajuste aprovada por outra pessoa — movimento gravado.' : 'Proposta de ajuste rejeitada — saldo não alterado.',
    },
    transaction
  );
  return proposal;
}

async function listAdjustmentProposals(groupId, companyId, transaction, { status } = {}) {
  const where = { groupId, companyId };
  if (status) where.status = status;
  return InventoryAdjustmentProposal.findAll({
    where,
    include: [
      { model: InventoryItem, as: 'inventoryItem', attributes: ['id', 'name', 'sku', 'unitOfMeasure'] },
      { model: InventoryLocation, as: 'sourceLocation', attributes: ['id', 'name'] },
      { model: InventoryLocation, as: 'destinationLocation', attributes: ['id', 'name'] },
      { model: User, as: 'proposedByUser', attributes: ['id', 'name'] },
      { model: User, as: 'decidedByUser', attributes: ['id', 'name'] },
    ],
    order: [['created_at', 'DESC']],
    limit: 500,
    transaction,
  });
}

module.exports = {
  MOVEMENT_TYPES,
  APPROVAL_REQUIRED_TYPES,
  recordMovement,
  getBalance,
  listBalancesByItem,
  listMovements,
  assertLocationsNotFrozenByCount,
  proposeAdjustment,
  decideAdjustmentProposal,
  listAdjustmentProposals,
};
