'use strict';

const { Op } = require('sequelize');
const {
  PurchaseRequest,
  PurchaseRequestItem,
  Project,
  Quotation,
  SupplierOffer,
  SupplierOfferItem,
  PurchaseOrder,
  PurchaseOrderItem,
  GoodsReceipt,
  GoodsReceiptItem,
  ReceiptDiscrepancy,
  SupplierEvaluation,
  SupplierQualification,
  FinancialEntry,
} = require('../../models');
const { InventoryStockBalance, Person, User, InventoryItem, File, InventoryLocation, ProjectStage } = require('../../models');
const AppError = require('../../utils/AppError');
const { registrarAuditoria, registrarTentativaBloqueada } = require('../../engines/audit/auditLog.service');
const { confirmReceipt: confirmInventoryReceipt, createReceipt: createInventoryReceipt } = require('../inventory/receipts.service');
const { recordMovement } = require('../inventory/movements.service');
const { createFinancialEntry, reverseFinancialEntry } = require('../finance/financialEntries.service');
const { getOrCreateDefaultCostCenter } = require('../finance/costCenters.service');
const { getActiveSecondApprovalThreshold } = require('./approvalThresholdRules.service');
// BUG REAL CORRIGIDO (auditoria externa Nayara, 2026-10-07; contrato, Centro Financeiro
// BLINDADO v1, §4: "Centro de custo obrigatório para despesa"): o payable de recebimento de
// materiais nasce de um fluxo automático (confirmação de goods receipt) sem nenhum centro de
// custo informado — ver getOrCreateDefaultCostCenter em costCenters.service.js.
const PROCUREMENT_COST_CENTER_CODE = 'COMPRAS-RECEBIMENTOS';

// Texto de trilha legível (auditoria Marco 7 "final2", 18/10/2026): a nota da divergência aceita
// saía "[payable <uuid> criado para o excedente de 30] [... recebimento <uuid>]" — identificador
// técnico, termo em inglês e valor sem R$.
const BRL_FORMAT = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
const QTY_FORMAT = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 4 });
function formatBRLText(value) {
  return BRL_FORMAT.format(Number(value) || 0);
}
function formatQtyText(value, unit) {
  return `${QTY_FORMAT.format(Number(value) || 0)} ${unit || 'un.'}`;
}

function round2(value) {
  return Math.round(Number(value) * 100) / 100;
}

// "YYYY-MM-DD" do dia corrente em America/Sao_Paulo (locale en-CA formata nesse padrão).
function todayInSaoPaulo() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
}

// DATEONLY ("YYYY-MM-DD") válida — mesmo cuidado documentado em insurance.service.js: nunca usar
// `new Date(str)` cru pra validar uma string DATEONLY (motores diferentes de parsing/timezone
// podem "corrigir" uma data inválida tipo "2026-02-30" pra outra data válida silenciosamente).
// Valida o formato por regex e depois confere se os componentes realmente formam aquela data.
function isValidDateOnly(value) {
  if (typeof value !== 'string') return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const [, y, m, d] = match.map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

// Tolerância de 1 centavo pra diferença de arredondamento entre soma de linhas e total da NF —
// mesmo espírito de `generateInstallments`/`confirmClaimSettlement` já usados no projeto.
const INVOICE_AMOUNT_TOLERANCE = 0.01;

// Caderno "COMPRAS/PROCUREMENT": REQUEST -> APPROVAL -> RFQ -> COMPARISON -> AWARD -> PO ->
// RECEIPT -> MATCH -> PAYABLE. PO = committed cost (contabilizado só como compromisso, nunca
// lançado no Financeiro aqui — isso é escopo de Financeiro); receipt = Estoque (reusa
// inventory.receipts, nunca duplica a baixa física); invoice match = three-way match PO x
// goods_receipt_item x valor recebido, abre ReceiptDiscrepancy quando não bate.

// --- 1. REQUEST ---
async function createPurchaseRequest(payload, actorUserId, transaction) {
  const { groupId, companyId, projectId, notes, items } = payload;
  if (!groupId || !companyId || !Array.isArray(items) || items.length === 0) {
    throw AppError.badRequest('Os campos "groupId", "companyId" e "items" (não vazio) são obrigatórios.', 'PURCHASE_REQUEST_VALIDATION');
  }
  for (const line of items) {
    if (!line.description || line.quantity == null || !Number.isFinite(Number(line.quantity)) || Number(line.quantity) <= 0) {
      throw AppError.badRequest('Cada item precisa de "description" e "quantity" > 0.', 'PURCHASE_REQUEST_VALIDATION');
    }
  }

  const request = await PurchaseRequest.create(
    { groupId, companyId, projectId: projectId || null, notes: notes || null, status: 'REQUESTED', requestedByUserId: actorUserId || null, createdBy: actorUserId || null, updatedBy: actorUserId || null },
    { transaction }
  );

  // Caderno Operacional §34: nova requisição de compra deve verificar estoque existente antes
  // de abrir, pra evitar compra duplicada do que já há em almoxarifado. Implementado como
  // AVISO (não bloqueio) — pode haver motivo legítimo de comprar mesmo com saldo existente
  // (ex.: já reservado para outro projeto), mesma lógica de "NAY sugere, nunca decide"
  // (EST-013) aplicada aqui a uma checagem automática de sistema.
  const stockWarnings = [];
  for (const line of items) {
    await PurchaseRequestItem.create(
      { groupId, companyId, purchaseRequestId: request.id, inventoryItemId: line.inventoryItemId || null, description: line.description, quantity: line.quantity },
      { transaction }
    );
    if (line.inventoryItemId) {
      const balances = await InventoryStockBalance.findAll({ where: { inventoryItemId: line.inventoryItemId }, transaction });
      const totalOnHand = balances.reduce((sum, b) => sum + Number(b.quantityOnHand), 0);
      if (totalOnHand >= Number(line.quantity)) {
        stockWarnings.push({ inventoryItemId: line.inventoryItemId, description: line.description, requestedQuantity: line.quantity, availableQuantity: totalOnHand });
      }
    }
  }
  await registrarAuditoria({ groupId, companyId, actorUserId, action: 'PURCHASE_REQUEST_CREATED', entityType: 'PurchaseRequest', entityId: request.id,
    afterJson: { ...request.toJSON(), items: items.map((l) => ({ inventoryItemId: l.inventoryItemId || null, description: l.description, quantity: l.quantity })), stockWarningCount: stockWarnings.length },
    reason: 'Requisição de compra criada.' }, transaction);

  const created = await getPurchaseRequest(request.id, groupId, companyId, transaction);
  return { ...created.toJSON(), stockWarnings };
}

// BUG REAL CORRIGIDO (reauditoria RLS/multi-tenant, 2026-10-08): o projeto não usa RLS real do
// Postgres (SET LOCAL app.group_id/company_id em tenant.middleware.js não tem CREATE POLICY
// correspondente) — isolamento é 100% a cargo do filtro manual no where. `findByPk(id)` sem
// groupId/companyId deixava qualquer tenant ler/decidir/adjudicar/cancelar sobre o registro de
// OUTRA empresa só adivinhando o UUID. Mesmo padrão já corrigido em materialRequests.service.js.
async function getPurchaseRequest(id, groupId, companyId, transaction) {
  const request = await PurchaseRequest.findOne({
    where: { id, groupId, companyId },
    include: [
      { model: PurchaseRequestItem, as: 'items' },
      { model: Project, as: 'project', attributes: ['id', 'name'] },
      { model: User, as: 'requestedByUser', attributes: ['id', 'name'] },
    ],
    transaction,
  });
  if (!request) throw AppError.notFound('Requisição de compra não encontrada.', 'PURCHASE_REQUEST_NOT_FOUND');
  return request;
}

// F8 (auditoria Marco 7, Nayara, 14/10/2026): a lista não trazia os itens nem o solicitante,
// então o front só conseguia mostrar status e data — nada que identificasse a requisição (obra,
// item, quantidade). `include` dos itens resolve isso sem N+1 no front.
async function listPurchaseRequests(groupId, companyId, transaction, { status } = {}) {
  const where = { groupId, companyId };
  if (status) where.status = status;
  return PurchaseRequest.findAll({
    where,
    include: [{ model: PurchaseRequestItem, as: 'items' }, { model: Project, as: 'project', attributes: ['id', 'name'] }],
    order: [['created_at', 'DESC']],
    limit: 1500,
    transaction,
  });
}

// --- 2. APPROVAL ---
// GAP REAL CORRIGIDO (auditoria contratual, 2026-10-08 — Anexo "Arquitetura Técnica Blindada",
// princípio constitucional "quem cria não aprova; quem aprova não altera; quem executa valida o
// hash aprovado"): nada impedia o MESMO usuário que criou a PurchaseRequest
// (`requestedByUserId`) de também decidir (aprovar/rejeitar) ela própria — qualquer ator com
// `procurement:approve` podia se autoaprovar. Fail-closed: bloqueia sempre que
// `actorUserId === request.requestedByUserId`, mesmo que ele também tenha a permissão de
// aprovação (a permissão concede a CAPACIDADE de aprovar pedidos; a segregação aqui decide QUAL
// pedido ele pode aprovar — nunca o próprio).
async function decidePurchaseRequest(id, groupId, companyId, decision, actorUserId, transaction) {
  if (!['APPROVED', 'REJECTED'].includes(decision)) {
    throw AppError.badRequest('"decision" precisa ser "APPROVED" ou "REJECTED".', 'PURCHASE_REQUEST_VALIDATION');
  }
  const request = await PurchaseRequest.findOne({ where: { id, groupId, companyId }, transaction, lock: transaction.LOCK.UPDATE });
  if (!request) throw AppError.notFound('Requisição de compra não encontrada.', 'PURCHASE_REQUEST_NOT_FOUND');
  if (request.status !== 'REQUESTED') {
    throw AppError.badRequest(`Só é possível decidir uma requisição em REQUESTED (atual: ${request.status}).`, 'PURCHASE_REQUEST_INVALID_TRANSITION');
  }
  // BUG REAL CORRIGIDO (auditoria rodada 3, 2026-10-08): a checagem anterior era fail-open
  // quando `requestedByUserId` estava null/undefined — a trava de segregação era simplesmente
  // PULADA em vez de ativada, permitindo autoaprovação sempre que o dado estivesse ausente.
  // `requestedByUserId` é SEMPRE preenchido em createPurchaseRequest (ver acima), então um valor
  // null aqui só pode vir de dado legado/corrompido — tratamos isso como anômalo e bloqueamos a
  // decisão (fail-closed) em vez de permitir a autoaprovação silenciosamente.
  if (!request.requestedByUserId) {
    await registrarTentativaBloqueada(
      {
        groupId,
        companyId,
        actorUserId,
        action: 'procurement.purchase_request.decide',
        entityType: 'PurchaseRequest',
        entityId: request.id,
        beforeJson: request.toJSON(),
        reason: 'Requisição de compra sem criador registrado — segregação "quem cria não aprova" não pode ser garantida.',
      },
      transaction
    );
    throw AppError.conflict(
      'Requisição de compra sem criador registrado (dado anômalo) — não é possível garantir a segregação "quem cria não aprova".',
      'PURCHASE_REQUEST_MISSING_REQUESTER'
    );
  }
  if (actorUserId && String(request.requestedByUserId) === String(actorUserId)) {
    await registrarTentativaBloqueada(
      {
        groupId,
        companyId,
        actorUserId,
        action: 'procurement.purchase_request.decide',
        entityType: 'PurchaseRequest',
        entityId: request.id,
        beforeJson: request.toJSON(),
        reason: 'Tentativa de autoaprovação — quem cria a requisição tentou decidi-la.',
      },
      transaction
    );
    throw AppError.forbidden(
      'Quem cria uma requisição de compra não pode aprová-la/rejeitá-la — peça a decisão de outro aprovador.',
      'PURCHASE_REQUEST_SELF_APPROVAL_FORBIDDEN'
    );
  }
  const auditBefore = { status: request.status, approvedByUserId: request.approvedByUserId, requestedByUserId: request.requestedByUserId };
  request.status = decision;
  request.approvedByUserId = actorUserId || null;
  request.updatedBy = actorUserId || null;
  await request.save({ transaction });
  await registrarAuditoria(
    {
      groupId: request.groupId,
      companyId: request.companyId,
      actorUserId,
      action: 'PURCHASE_REQUEST_DECIDED',
      entityType: 'PurchaseRequest',
      entityId: request.id,
      beforeJson: auditBefore,
      afterJson: { status: request.status, approvedByUserId: request.approvedByUserId, requestedByUserId: request.requestedByUserId },
      reason: decision === 'APPROVED' ? 'Requisição de compra aprovada.' : 'Requisição de compra rejeitada.',
    },
    transaction
  );
  return request;
}

// --- 3. RFQ ---
// GAP REAL CORRIGIDO (auditoria contratual, 2026-10-08 — Anexo I, "RFQ sem convite dirigido a
// fornecedores específicos"): até aqui, qualquer fornecedor podia registrar oferta contra uma
// Quotation OPEN, sem nenhum conceito de convite prévio. `invitedSupplierIds` (opcional, array
// de Person ids) persiste a lista de convidados em `procurement.quotations.invited_supplier_ids`
// (migration 20260101000312). DECISÃO DE COMPATIBILIDADE RETROATIVA: lista ausente/vazia
// preserva o comportamento antigo — qualquer fornecedor pode ofertar (ver submitSupplierOffer).
//
// BLOQUEIO DE INFRAESTRUTURA (mesma classe já documentada em test/crm.carts.test.js e
// src/features/people/personMerge.service.js): a credencial de DDL (`nayara_migration` em
// `.env.migration.local`) está rejeitada pelo Postgres nesta sessão, e o usuário de runtime
// (DATABASE_URL) não tem CREATE/ALTER em nenhum schema — a migration 20260101000312 não pôde
// ser aplicada ao banco. Para não quebrar TODA a suíte de procurement (declarar
// `invitedSupplierIds` como atributo do model `Quotation` faria todo SELECT/INSERT existente
// falhar com "column ... does not exist" até a migration rodar), a coluna é checada em runtime
// (`hasQuotationInvitationsColumn`, cacheada) e lida/escrita via SQL cru só quando existir —
// nunca via atributo declarado no model. Enquanto a coluna não existir, convite vira um no-op
// (nenhum convite é persistido/aplicado) e o comportamento atual (qualquer fornecedor oferta) é
// preservado — fail-open deliberado só para esta feature nova, nunca para os 2 fluxos
// financeiros/físicos já existentes no resto do arquivo.
let quotationInvitationsColumnExists = null;
async function hasQuotationInvitationsColumn(transaction) {
  if (quotationInvitationsColumnExists !== null) return quotationInvitationsColumnExists;
  const [rows] = await Quotation.sequelize.query(
    `SELECT 1 FROM information_schema.columns WHERE table_schema = 'procurement' AND table_name = 'quotations' AND column_name = 'invited_supplier_ids'`,
    { transaction }
  );
  quotationInvitationsColumnExists = rows.length > 0;
  return quotationInvitationsColumnExists;
}

async function getQuotationInvitedSupplierIds(quotationId, transaction) {
  if (!(await hasQuotationInvitationsColumn(transaction))) return null;
  const [rows] = await Quotation.sequelize.query(
    `SELECT invited_supplier_ids FROM procurement.quotations WHERE id = :id`,
    { replacements: { id: quotationId }, transaction }
  );
  return rows[0] ? rows[0].invited_supplier_ids : null;
}

async function setQuotationInvitedSupplierIds(quotationId, invitedSupplierIds, transaction) {
  if (!(await hasQuotationInvitationsColumn(transaction))) return false;
  await Quotation.sequelize.query(
    `UPDATE procurement.quotations SET invited_supplier_ids = :invited WHERE id = :id`,
    { replacements: { invited: invitedSupplierIds ? JSON.stringify(invitedSupplierIds) : null, id: quotationId }, transaction }
  );
  return true;
}

async function createQuotation(purchaseRequestId, groupId, companyId, actorUserId, transaction, options = {}) {
  const { invitedSupplierIds } = options || {};
  if (invitedSupplierIds != null && (!Array.isArray(invitedSupplierIds) || invitedSupplierIds.some((v) => !v))) {
    throw AppError.badRequest('"invitedSupplierIds", quando informado, precisa ser um array não vazio de ids válidos.', 'QUOTATION_VALIDATION');
  }
  // BUG REAL CORRIGIDO (auditoria "loop até secar" ciclo 1 paralelo, 2026-10-06): sem lock
  // pessimista aqui, duas chamadas concorrentes (duplo clique, 2 abas) liam ambas "nenhuma
  // OPEN existente" (TOCTOU — não há constraint única em `quotations(purchase_request_id,
  // status)`) e cada uma criava sua própria Quotation OPEN. As ofertas de fornecedores
  // submetidas depois ficavam espalhadas entre as duas cotações-irmãs, quebrando compareOffers
  // (só olha uma quotationId por vez) e permitindo adjudicar a mesma requisição duas vezes via
  // awardSupplierOffer em cotações diferentes. Lock FOR UPDATE na PurchaseRequest serializa as
  // duas chamadas: a segunda só lê depois do commit da primeira e reaproveita a OPEN já criada.
  const request = await PurchaseRequest.findOne({ where: { id: purchaseRequestId, groupId, companyId }, transaction, lock: transaction.LOCK.UPDATE });
  if (!request) throw AppError.notFound('Requisição de compra não encontrada.', 'PURCHASE_REQUEST_NOT_FOUND');
  if (request.status !== 'APPROVED') {
    throw AppError.badRequest('Só é possível abrir cotação para uma requisição APPROVED.', 'QUOTATION_INVALID_SOURCE');
  }
  // BUG REAL CORRIGIDO (auditoria E2E Marco 7, ciclo 5): toda chamada criava uma Quotation
  // nova, mesmo já existindo uma OPEN para a mesma requisição — ao reabrir a tela (reload,
  // nova sessão), as ofertas já submetidas na quotation antiga ficavam órfãs (vinculadas a um
  // quotationId que a UI nunca mais consultava) e sumiam da comparação. Reaproveita a OPEN
  // existente em vez de criar outra (idempotente por requisição).
  const existing = await Quotation.findOne({ where: { purchaseRequestId: request.id, status: 'OPEN' }, transaction });
  if (existing) return existing;
  const quotation = await Quotation.create(
    { groupId: request.groupId, companyId: request.companyId, purchaseRequestId: request.id, status: 'OPEN', createdBy: actorUserId || null, updatedBy: actorUserId || null },
    { transaction }
  );
  if (Array.isArray(invitedSupplierIds) && invitedSupplierIds.length > 0) {
    await setQuotationInvitedSupplierIds(quotation.id, invitedSupplierIds, transaction);
    // Propriedade transiente (não é atributo declarado do model — nunca persiste sozinha via
    // .save(), mesmo padrão de supplierPersonName em compareOffers/attachSupplierPersonNames):
    // só devolve pro chamador desta mesma chamada o que acabou de ser gravado via SQL cru acima.
    quotation.invitedSupplierIds = invitedSupplierIds;
  }
  return quotation;
}

async function submitSupplierOffer(quotationId, groupId, companyId, payload, transaction) {
  const { supplierPersonId, items } = payload;
  if (!supplierPersonId || !Array.isArray(items) || items.length === 0) {
    throw AppError.badRequest('"supplierPersonId" e "items" (não vazio) são obrigatórios.', 'SUPPLIER_OFFER_VALIDATION');
  }
  // BUG REAL CORRIGIDO (auditoria concorrência, 2026-10-08): leitura sem lock permitia uma
  // adjudicação concorrente (awardSupplierOffer, que trava a Quotation com FOR UPDATE) fechar a
  // cotação entre esta leitura e a criação da oferta — gerando uma SupplierOffer "órfã" presa a
  // uma Quotation já AWARDED/CANCELLED. Mesmo padrão de lock já usado em awardSupplierOffer.
  const quotation = await Quotation.findOne({ where: { id: quotationId, groupId, companyId }, transaction, lock: transaction.LOCK.UPDATE });
  if (!quotation) throw AppError.notFound('Cotação não encontrada.', 'QUOTATION_NOT_FOUND');
  if (quotation.status !== 'OPEN') {
    throw AppError.badRequest(`Só é possível submeter oferta para uma cotação OPEN (atual: ${quotation.status}).`, 'QUOTATION_INVALID_TRANSITION');
  }

  // GAP REAL CORRIGIDO (auditoria contratual, 2026-10-08 — "RFQ sem convite dirigido a
  // fornecedores específicos"): se esta RFQ tem lista de convidados, só quem está nela pode
  // ofertar — fail-closed. Lista ausente/vazia (null, [], ou coluna ainda não migrada — ver
  // hasQuotationInvitationsColumn) preserva o comportamento antigo: qualquer fornecedor oferta.
  const invitedSupplierIds = await getQuotationInvitedSupplierIds(quotation.id, transaction);
  if (Array.isArray(invitedSupplierIds) && invitedSupplierIds.length > 0 && !invitedSupplierIds.includes(supplierPersonId)) {
    await registrarTentativaBloqueada(
      {
        groupId: quotation.groupId,
        companyId: quotation.companyId,
        actorUserId: null,
        action: 'procurement.supplier_offer.submit',
        entityType: 'Quotation',
        entityId: quotation.id,
        reason: `Fornecedor ${supplierPersonId} tentou ofertar numa RFQ com convite dirigido sem estar na lista de convidados.`,
      },
      transaction
    );
    throw AppError.forbidden(
      'Este fornecedor não foi convidado para esta cotação (RFQ com convite dirigido) — só fornecedores convidados podem ofertar.',
      'PROCUREMENT_SUPPLIER_NOT_INVITED'
    );
  }

  let totalAmount = 0;
  const offer = await SupplierOffer.create(
    { groupId: quotation.groupId, companyId: quotation.companyId, quotationId: quotation.id, supplierPersonId, status: 'RECEIVED' },
    { transaction }
  );
  for (const line of items) {
    // BUG REAL CORRIGIDO (auditoria "loop até secar", rodada 58, 2026-10-06): o guard usava
    // `Number(unitPrice) < 0`, falso para NaN — um payload com unitPrice:"NaN" passava (Postgres
    // NUMERIC aceita o literal 'NaN'), corrompendo totalAmount/committedAmount do PO adjudicado.
    if (!line.purchaseRequestItemId || line.unitPrice == null || !Number.isFinite(Number(line.unitPrice)) || Number(line.unitPrice) < 0) {
      throw AppError.badRequest('Cada item precisa de "purchaseRequestItemId" e "unitPrice" >= 0.', 'SUPPLIER_OFFER_VALIDATION');
    }
    const prItem = await PurchaseRequestItem.findOne({ where: { id: line.purchaseRequestItemId, groupId: quotation.groupId, companyId: quotation.companyId }, transaction });
    if (!prItem) throw AppError.notFound(`Item de requisição "${line.purchaseRequestItemId}" não encontrado.`, 'PURCHASE_REQUEST_ITEM_NOT_FOUND');
    await SupplierOfferItem.create(
      { groupId: quotation.groupId, companyId: quotation.companyId, supplierOfferId: offer.id, purchaseRequestItemId: line.purchaseRequestItemId, unitPrice: line.unitPrice },
      { transaction }
    );
    totalAmount += Number(line.unitPrice) * Number(prItem.quantity);
  }
  offer.totalAmount = totalAmount;
  await offer.save({ transaction });
  return offer;
}

// --- 4. COMPARISON (read-only) ---
async function compareOffers(quotationId, groupId, companyId, transaction) {
  const quotation = await Quotation.findOne({
    where: { id: quotationId, groupId, companyId },
    include: [{ model: SupplierOffer, as: 'offers', include: [{ model: SupplierOfferItem, as: 'items' }] }],
    transaction,
  });
  if (!quotation) throw AppError.notFound('Cotação não encontrada.', 'QUOTATION_NOT_FOUND');
  const offers = quotation.offers.slice().sort((a, b) => Number(a.totalAmount) - Number(b.totalAmount));

  // BUG REAL CORRIGIDO (auditoria "loop até secar", rodada 61, 2026-10-06): compareOffers nunca
  // incluía o nome do fornecedor — a tela de comparação de ofertas (/painel/compras) mostrava
  // supplierPersonId cru (UUID), sem forma de saber quem está ofertando (Categoria 6 do catálogo
  // de bugs). SupplierOffer não tem FK Sequelize pra Person (schema cruzado procurement/people,
  // mesmo padrão de constraints:false usado no resto do módulo), então busca-se separado.
  const supplierIds = [...new Set(offers.map((o) => o.supplierPersonId).filter(Boolean))];
  const nameById = new Map();
  if (supplierIds.length > 0) {
    const people = await Person.findAll({ where: { id: supplierIds }, attributes: ['id', 'legalName'], transaction });
    for (const p of people) nameById.set(p.id, p.legalName);
  }

  // `supplierPersonName` não é atributo declarado no model — sem instância plain (toJSON), o
  // JSON.stringify da resposta HTTP (via res.json -> Model.toJSON -> get({plain:true})) IGNORA
  // qualquer propriedade atribuída diretamente na instância Sequelize, nunca chegando ao front.
  return offers.map((offer) => ({ ...offer.toJSON(), supplierPersonName: nameById.get(offer.supplierPersonId) || null }));
}

// --- 5. AWARD -> 6. PO ---
async function awardSupplierOffer(offerId, groupId, companyId, actorUserId, transaction) {
  // Postgres rejeita FOR UPDATE combinado com include de hasMany (outer join nullable) — lock
  // só na linha da oferta; os itens (imutáveis após submissão) são lidos separadamente.
  const offer = await SupplierOffer.findOne({ where: { id: offerId, groupId, companyId }, transaction, lock: transaction.LOCK.UPDATE });
  if (!offer) throw AppError.notFound('Oferta de fornecedor não encontrada.', 'SUPPLIER_OFFER_NOT_FOUND');
  if (offer.status !== 'RECEIVED') {
    throw AppError.badRequest(`Só é possível adjudicar uma oferta RECEIVED (atual: ${offer.status}).`, 'SUPPLIER_OFFER_INVALID_TRANSITION');
  }
  offer.items = await SupplierOfferItem.findAll({ where: { supplierOfferId: offer.id }, transaction });
  const quotation = await Quotation.findOne({ where: { id: offer.quotationId, groupId: offer.groupId, companyId: offer.companyId }, transaction, lock: transaction.LOCK.UPDATE });
  const request = await PurchaseRequest.findOne({ where: { id: quotation.purchaseRequestId, groupId: offer.groupId, companyId: offer.companyId }, transaction, lock: transaction.LOCK.UPDATE });

  // BUG REAL CORRIGIDO (auditoria "loop até secar", rodada 57, 2026-10-06): awardSupplierOffer só
  // validava o status da SupplierOffer, nunca o da Quotation — uma cotação com 2+ ofertas RECEIVED
  // podia ser adjudicada duas vezes (a oferta vencedora muda de status, mas as outras continuam
  // RECEIVED e passam pela única guarda existente), gerando múltiplos PurchaseOrder concorrentes
  // para a mesma PurchaseRequest e duplicando o custo comprometido.
  if (quotation.status !== 'OPEN') {
    throw AppError.conflict('Esta cotação já foi adjudicada.', 'QUOTATION_ALREADY_AWARDED');
  }

  // Contrato (Anexo I, "Fornecedores: documentos/vigência; due diligence para alto risco") —
  // fornecedor marcado como alto risco só pode ser adjudicado com due diligence APPROVED e
  // ainda dentro da vigência (validUntil). Fail-closed: sem registro de qualificação nenhum,
  // trata como ainda não qualificado (nunca assume "ok" por omissão). CUIDADO: esta checagem
  // usa `offer.companyId` (já validado como do tenant acima) — não trocar por outra variável.
  const qualification = await SupplierQualification.findOne({
    where: { companyId: offer.companyId, supplierPersonId: offer.supplierPersonId },
    transaction,
  });
  // REVISÃO MARCO 7 (19/10/2026, B10): documentos e vigência só eram checados no alto risco — um
  // fornecedor SEM qualificação nenhuma era adjudicado (o "fail-closed" acima não valia para ele).
  // Agora vale para todo fornecedor: precisa de qualificação com pelo menos um documento anexado
  // (arquivo existente da empresa) e vigência informada e não vencida. A due diligence continua
  // exigida só para alto risco (checada primeiro, mantendo o código de erro já conhecido).
  if (!qualification) {
    throw AppError.badRequest(
      'Fornecedor sem qualificação cadastrada (documentos e vigência) — cadastre a qualificação antes de gerar o pedido.',
      'SUPPLIER_QUALIFICATION_REQUIRED'
    );
  }
  if (qualification.highRisk) {
    // validUntil é DATEONLY e a vigência INCLUI o último dia. `new Date('YYYY-MM-DD') < new Date()`
    // ancorava em meia-noite UTC — "válido até 31/12" já contava como vencido no próprio dia 31
    // (desde 21h do dia 30 em São Paulo). Compara por data de calendário de São Paulo.
    const expired = qualification.validUntil && String(qualification.validUntil) < todayInSaoPaulo();
    if (qualification.dueDiligenceStatus !== 'APPROVED' || expired) {
      throw AppError.badRequest(
        'Fornecedor de alto risco precisa de due diligence aprovada e dentro da vigência antes de receber uma PO.',
        'SUPPLIER_DUE_DILIGENCE_REQUIRED'
      );
    }
  }
  {
    const documentIds = Array.isArray(qualification.documentFileIds) ? qualification.documentFileIds.filter(Boolean) : [];
    const existingDocuments = documentIds.length
      ? await File.count({ where: { id: documentIds, companyId: offer.companyId }, transaction })
      : 0;
    const validityMissingOrExpired = !qualification.validUntil || String(qualification.validUntil) < todayInSaoPaulo();
    if (existingDocuments === 0 || validityMissingOrExpired) {
      throw AppError.badRequest(
        validityMissingOrExpired
          ? 'A qualificação do fornecedor está sem vigência ou vencida — atualize documentos e vigência antes de gerar o pedido.'
          : 'A qualificação do fornecedor não tem nenhum documento anexado — anexe os documentos antes de gerar o pedido.',
        'SUPPLIER_QUALIFICATION_REQUIRED'
      );
    }
  }

  // GAP REAL CORRIGIDO (auditoria contratual, 2026-10-08 — mesmo princípio constitucional de
  // decidePurchaseRequest acima): decidimos NÃO aplicar aqui uma checagem de "quem cria não
  // aprova" comparando o ator que adjudica contra um "criador" da SupplierOffer/Quotation —
  // SupplierOffer é submetida pelo FORNECEDOR (supplierPersonId), não tem nenhum createdBy de
  // ator interno (ver model), e Quotation.createdBy é só quem abriu a RFQ (procurement:create),
  // um papel operacional sem relação de autoria com a decisão de adjudicar (procurement:approve)
  // — comparar actorUserId com quotation.createdBy geraria falso-positivo toda vez que o mesmo
  // comprador abre a cotação E adjudica a oferta vencedora, fluxo legítimo e comum no projeto.
  // O ponto de autoria que de fato importa aqui — "quem decidiu a PurchaseRequest" — já é
  // tratado em decidePurchaseRequest (não pode ser quem criou a request) e, abaixo, na alçada
  // por VALOR (REG-COM-001): acima do limiar, a adjudicação exige um ator diferente de quem
  // aprovou a PurchaseRequest original (segundo aprovador).
  const { secondApprovalThreshold } = await getActiveSecondApprovalThreshold(offer.groupId, offer.companyId, transaction, actorUserId);
  if (Number(offer.totalAmount) >= secondApprovalThreshold) {
    // BUG REAL CORRIGIDO (auditoria rodada 3, 2026-10-08): mesmo padrão fail-open do bug de
    // decidePurchaseRequest — quando `request.approvedByUserId` está null/undefined (dado
    // legado/corrompido, já que decidePurchaseRequest sempre preenche esse campo ao aprovar), a
    // exigência de segundo aprovador (REG-COM-001) era simplesmente PULADA. Se não é possível
    // confirmar que existe um segundo aprovador distinto, trata como fail-closed: exige a
    // segunda aprovação mesmo assim, bloqueando com o mesmo erro.
    if (!request.approvedByUserId || (actorUserId && String(request.approvedByUserId) === String(actorUserId))) {
      await registrarTentativaBloqueada(
        {
          groupId: offer.groupId,
          companyId: offer.companyId,
          actorUserId,
          action: 'procurement.supplier_offer.award',
          entityType: 'SupplierOffer',
          entityId: offer.id,
          beforeJson: { offer: offer.toJSON(), request: request.toJSON() },
          reason: 'Adjudicação de alto valor sem segundo aprovador distinto.',
        },
        transaction
      );
      throw AppError.forbidden(
        `Oferta de valor R$ ${Number(offer.totalAmount).toFixed(2)} (>= limiar de R$ ${secondApprovalThreshold.toFixed(2)} para segunda aprovação) não pode ser adjudicada pelo mesmo ator que aprovou a requisição de compra original — é exigido um segundo aprovador.`,
        'PURCHASE_ORDER_SECOND_APPROVAL_REQUIRED_HIGH_VALUE'
      );
    }
  }

  const order = await PurchaseOrder.create(
    {
      groupId: offer.groupId,
      companyId: offer.companyId,
      purchaseRequestId: request.id,
      supplierOfferId: offer.id,
      supplierPersonId: offer.supplierPersonId,
      status: 'OPEN',
      committedAmount: offer.totalAmount,
      createdBy: actorUserId || null,
      updatedBy: actorUserId || null,
    },
    { transaction }
  );
  for (const offerItem of offer.items) {
    const prItem = await PurchaseRequestItem.findOne({ where: { id: offerItem.purchaseRequestItemId, groupId: offer.groupId, companyId: offer.companyId }, transaction });
    await PurchaseOrderItem.create(
      {
        groupId: offer.groupId,
        companyId: offer.companyId,
        purchaseOrderId: order.id,
        inventoryItemId: prItem.inventoryItemId,
        description: prItem.description,
        quantity: prItem.quantity,
        unitPrice: offerItem.unitPrice,
      },
      { transaction }
    );
  }

  const auditBefore = { offerStatus: offer.status, quotationStatus: quotation.status, purchaseRequestStatus: request.status, purchaseOrder: 'Não existia (pedido criado nesta ação)' };
  offer.status = 'AWARDED';
  await offer.save({ transaction });
  quotation.status = 'CLOSED';
  await quotation.save({ transaction });
  request.status = 'AWARDED';
  request.updatedBy = actorUserId || null;
  await request.save({ transaction });

  await registrarAuditoria({ groupId: order.groupId, companyId: order.companyId, actorUserId, action: 'PURCHASE_ORDER_CREATED', entityType: 'PurchaseOrder', entityId: order.id,
    beforeJson: auditBefore,
    afterJson: {
      ...order.toJSON(),
      offerStatus: offer.status,
      quotationStatus: quotation.status,
      purchaseRequestStatus: request.status,
      items: offer.items.map((i) => ({ purchaseRequestItemId: i.purchaseRequestItemId, unitPrice: i.unitPrice })),
    },
    reason: `PO gerada a partir da oferta ${offer.id} — custo comprometido ${order.committedAmount}.` }, transaction);

  return getPurchaseOrder(order.id, order.groupId, order.companyId, transaction);
}

// BUG REAL CORRIGIDO (auditoria "loop até secar", rodada 62, 2026-10-06): PurchaseOrder só tem
// supplierPersonId (sem FK Sequelize pra Person, schema cruzado procurement/people) — a tela de
// Pedidos de Compra mostrava o UUID cru na coluna "Fornecedor" (mesma Categoria 6 do catálogo já
// corrigida em compareOffers na rodada 61, um passo adiante no funil).
async function attachSupplierPersonNames(orders, transaction) {
  const supplierIds = [...new Set(orders.map((o) => o.supplierPersonId).filter(Boolean))];
  const nameById = new Map();
  if (supplierIds.length > 0) {
    const people = await Person.findAll({ where: { id: supplierIds }, attributes: ['id', 'legalName'], transaction });
    for (const p of people) nameById.set(p.id, p.legalName);
  }
  return orders.map((order) => ({ ...order.toJSON(), supplierPersonName: nameById.get(order.supplierPersonId) || null }));
}

async function getPurchaseOrder(id, groupId, companyId, transaction) {
  const order = await PurchaseOrder.findOne({ where: { id, groupId, companyId }, include: [{ model: PurchaseOrderItem, as: 'items' }], transaction });
  if (!order) throw AppError.notFound('Pedido de compra não encontrado.', 'PURCHASE_ORDER_NOT_FOUND');
  const [withName] = await attachSupplierPersonNames([order], transaction);
  return withName;
}

async function listPurchaseOrders(groupId, companyId, transaction, { status } = {}) {
  const where = { groupId, companyId };
  if (status) where.status = status;
  const orders = await PurchaseOrder.findAll({ where, order: [['created_at', 'DESC']], limit: 1500, transaction });
  const withNames = await attachSupplierPersonNames(orders, transaction);
  // FIX (auditoria Marco 7 Compras E2E, 2026-10-18): o número da NF informado no recebimento
  // não aparecia em lugar nenhum do Pedido de compra. Anexa os números de NF dos recebimentos
  // de cada PO pra tela mostrar a rastreabilidade PO → NF.
  const orderIds = withNames.map((o) => o.id);
  if (orderIds.length > 0) {
    const receipts = await GoodsReceipt.findAll({ where: { purchaseOrderId: orderIds, groupId, companyId }, attributes: ['purchaseOrderId', 'invoiceFingerprint'], transaction });
    const nfByOrder = new Map();
    for (const r of receipts) {
      if (!r.invoiceFingerprint) continue;
      if (!nfByOrder.has(r.purchaseOrderId)) nfByOrder.set(r.purchaseOrderId, []);
      nfByOrder.get(r.purchaseOrderId).push(r.invoiceFingerprint);
    }
    for (const o of withNames) o.invoiceNumbers = nfByOrder.get(o.id) || [];
  }
  return withNames;
}

// --- 7. RECEIPT -> 8. MATCH ---
// EST-TS/Caderno "goods_receipts": over-receipt/invoice sem receipt tratados aqui. O recebimento
// FÍSICO real é delegado a inventory.receipts (nunca duplicamos a lógica de IN/saldo) — este
// serviço só cria o receipt de inventário com os itens do PO e abre discrepâncias.
async function confirmGoodsReceipt(purchaseOrderId, groupId, companyId, payload, actor, transaction) {
  const { destinationLocationId, invoiceFingerprint, invoiceTotalAmount, items, idempotencyKey } = payload;
  if (!destinationLocationId || !Array.isArray(items) || items.length === 0) {
    throw AppError.badRequest('"destinationLocationId" e "items" (não vazio) são obrigatórios.', 'GOODS_RECEIPT_VALIDATION');
  }

  // BUG REAL CORRIGIDO (auditoria RLS/concorrência, 2026-10-08): `invoiceTotalAmount` nunca era
  // validado com Number.isFinite — um valor NaN/Infinity/negativo passava direto pro three-way
  // match e pro cálculo do payable (payableAmount), corrompendo o contas a pagar gerado. Fail
  // closed: valida antes de usar em qualquer cálculo.
  if (invoiceTotalAmount != null && (!Number.isFinite(Number(invoiceTotalAmount)) || Number(invoiceTotalAmount) < 0)) {
    throw AppError.badRequest('"invoiceTotalAmount" precisa ser um número maior ou igual a zero.', 'GOODS_RECEIPT_VALIDATION');
  }

  const order = await PurchaseOrder.findOne({ where: { id: purchaseOrderId, groupId, companyId }, transaction, lock: transaction.LOCK.UPDATE });
  if (!order) throw AppError.notFound('Pedido de compra não encontrado.', 'PURCHASE_ORDER_NOT_FOUND');
  // BUG REAL CORRIGIDO (failure drill de Estoque/Compras, Marco 7, 19/10/2026): a checagem de
  // idempotência vinha DEPOIS da de NF duplicada — o retry de um recebimento que JÁ tinha dado
  // certo (mesma idempotencyKey, mesma NF; ex.: a resposta se perdeu na rede) era recusado com
  // GOODS_RECEIPT_DUPLICATE_INVOICE em vez de devolver o recebimento existente. Agora a chave de
  // idempotência é conferida primeiro (antes até do status do pedido: o replay do recebimento que
  // completou o pedido deve devolver o recebimento, não PURCHASE_ORDER_INVALID_TRANSITION); NF repetida com chave diferente continua bloqueada.
  // BUG REAL CORRIGIDO (auditoria "loop até secar", rodada 64, 2026-10-06): a única proteção
  // real contra duplo-processamento era o status do PO virar != OPEN, que só acontece no
  // recebimento TOTAL — em recebimento PARCIAL (PO continua OPEN), um retry de rede com o mesmo
  // payload criava um segundo GoodsReceipt + segundo FinancialEntry duplicado (a idempotencyKey
  // antiga usada no payable era derivada de goodsReceipt.id, gerado DENTRO desta própria
  // chamada — nunca podia colidir, não protegia nada). Chave opcional do cliente, mesmo padrão
  // de transferAsset/AssetMovement — se já processado, retorna o recebimento existente.
  if (idempotencyKey) {
    const existingByKey = await GoodsReceipt.findOne({ where: { companyId: order.companyId, idempotencyKey }, transaction });
    if (existingByKey) {
      const existingDiscrepancies = await ReceiptDiscrepancy.findAll({
        where: { goodsReceiptItemId: (await GoodsReceiptItem.findAll({ where: { goodsReceiptId: existingByKey.id }, attributes: ['id'], transaction })).map((i) => i.id) },
        transaction,
      });
      return { goodsReceipt: existingByKey, discrepancies: existingDiscrepancies };
    }
  }

  if (order.status !== 'OPEN') {
    throw AppError.badRequest(`Só é possível registrar recebimento para um pedido de compra em aberto (status atual: ${order.status}).`, 'PURCHASE_ORDER_INVALID_TRANSITION');
  }
  order.items = await PurchaseOrderItem.findAll({ where: { purchaseOrderId: order.id }, transaction });
  const auditBefore = {
    purchaseOrderStatus: order.status,
    goodsReceipt: 'Não existia (recebimento criado nesta ação)',
    items: order.items.map((i) => ({ purchaseOrderItemId: i.id, quantity: i.quantity, receivedQuantity: i.receivedQuantity })),
  };

  // BUG REAL CORRIGIDO (teste de carga de Estoque/Compras, Marco 7, 19/10/2026): dois
  // recebimentos simultâneos (pedidos diferentes) do MESMO item de estoque davam deadlock
  // (40P01). Cada um inseria os itens do recibo de estoque — o FK pega FOR KEY SHARE na linha do
  // item — e depois pedia FOR UPDATE na mesma linha para recalcular o custo médio: os dois
  // seguravam o KEY SHARE e esperavam um pelo outro. Agora as linhas dos itens de estoque do
  // pedido são travadas FOR UPDATE ANTES de qualquer insert, em ordem de id (ordem global
  // estável — sem ciclo entre pedidos com vários itens).
  const inventoryItemIdsToLock = [...new Set(order.items.map((i) => i.inventoryItemId).filter(Boolean))].sort();
  if (inventoryItemIdsToLock.length) {
    await InventoryItem.findAll({ where: { id: inventoryItemIdsToLock, groupId: order.groupId, companyId: order.companyId }, order: [['id', 'ASC']], transaction, lock: transaction.LOCK.UPDATE });
  }

  // BUG REAL CORRIGIDO (reauditoria "loop até secar", 2026-10-08): a checagem de NF duplicada
  // rodava ANTES do lock FOR UPDATE do PO — duas requisições concorrentes (sem idempotencyKey)
  // liam ambas "nenhum GoodsReceipt com este invoiceFingerprint" antes de qualquer commit (TOCTOU)
  // e as duas seguiam criando recebimento + payable duplicados. Agora a checagem roda DEPOIS do
  // lock do PO: a segunda chamada concorrente só lê este GoodsReceipt.findOne depois do commit da
  // primeira (serializada pela trava pessimista na linha do PO), encontrando o registro já criado.
  // REVISÃO MARCO 7 (19/10/2026, B11): a NF duplicada era procurada na EMPRESA inteira — a NF nº
  // 123 de um fornecedor bloqueava a NF nº 123 de outro fornecedor (numeração de NF é por
  // emitente). A chave agora é (empresa, fornecedor, número da NF), no serviço e no índice único
  // do banco (migration 20260101000590). Duplicidade é conflito (409), não erro de formato.
  if (invoiceFingerprint) {
    const existing = await GoodsReceipt.findOne({ where: { invoiceFingerprint, groupId: order.groupId, companyId: order.companyId, supplierPersonId: order.supplierPersonId }, transaction });
    if (existing) throw AppError.conflict(`Já existe um recebimento (${existing.id}) com esta mesma nota fiscal deste fornecedor.`, 'GOODS_RECEIPT_DUPLICATE_INVOICE');
  }

  const goodsReceipt = await GoodsReceipt.create(
    { groupId: order.groupId, companyId: order.companyId, purchaseOrderId: order.id, supplierPersonId: order.supplierPersonId, destinationLocationId, invoiceFingerprint: invoiceFingerprint || null, invoiceTotalAmount: invoiceTotalAmount != null ? invoiceTotalAmount : null, idempotencyKey: idempotencyKey || null, status: 'DRAFT', createdBy: actor.userId || null, updatedBy: actor.userId || null },
    { transaction }
  );

  const inventoryReceiptItems = [];
  const discrepancies = [];
  let firstGrItem = null;
  let expectedAmount = 0;
  // Valor de TUDO o que chegou fisicamente, a preço do pedido (inclui o excedente). É a base do
  // three-way match de preço: a NF que cobra o excedente a preço de pedido não é "divergência
  // de preço" — o excedente já é decidido pela própria divergência OVER_RECEIPT (B1).
  let fullReceivedAmount = 0;

  for (const line of items) {
    const poItem = order.items.find((i) => i.id === line.purchaseOrderItemId);
    if (!poItem) throw AppError.notFound(`Item do pedido de compra não encontrado.`, 'PURCHASE_ORDER_ITEM_NOT_FOUND');

    const receivedQty = Number(line.receivedQuantity);
    // BUG REAL CORRIGIDO (auditoria "loop até secar", rodada 56, 2026-10-06): nenhuma validação
    // de sinal/numérico em receivedQuantity — um valor negativo decrementava poItem.receivedQuantity
    // silenciosamente (sem disparar discrepância, já que `receivedQty > remaining` nunca é true para
    // negativo) e sem reverter estoque (guard `receivedQty > 0` abaixo impede o item de estoque),
    // desalinhando permanentemente o saldo recebido do PO vs. o estoque real.
    if (!Number.isFinite(receivedQty) || receivedQty <= 0) {
      throw AppError.badRequest(`"receivedQuantity" do item "${line.purchaseOrderItemId}" deve ser um número maior que zero.`, 'GOODS_RECEIPT_INVALID_QUANTITY');
    }
    const remaining = Number(poItem.quantity) - Number(poItem.receivedQuantity);
    // BUG REAL CORRIGIDO (over-receipt sem cap, 2026-10-08): quando `receivedQty > remaining`,
    // uma ReceiptDiscrepancy OVER_RECEIPT já era aberta, MAS o valor financeiro (expectedAmount,
    // base do payableAmount abaixo) somava a quantidade TOTAL recebida — incluindo o excedente —
    // criando o payable pelo valor cheio na MESMA transação, antes de qualquer resolução humana
    // do case. Capa a contribuição financeira no saldo do PO (`Math.min(receivedQty, remaining)`,
    // nunca negativo): o excedente fica registrado só como o OVER_RECEIPT, e só entra no payable
    // se `resolveDiscrepancy` aceitar o excedente como válido (ver fix lá).
    // BUG REAL CORRIGIDO (auditoria Marco 7 Compras E2E, 2026-10-18): a ENTRADA DE ESTOQUE usava
    // a quantidade física cheia ("já aconteceu") — mas isso deixava o excedente no SALDO antes de
    // qualquer decisão humana da divergência, inconsistente com o próprio cap financeiro acima.
    // Agora o estoque entra capado no saldo do PO também: o excedente só vira saldo quando a
    // divergência OVER_RECEIPT é ACEITA em resolveDiscrepancy (movimento adicional lá); rejeitada,
    // nunca entra (devolução ao fornecedor fica na trilha da resolução).
    const cappedQtyForAmount = Math.min(receivedQty, Math.max(remaining, 0));
    expectedAmount += cappedQtyForAmount * Number(poItem.unitPrice);
    fullReceivedAmount += receivedQty * Number(poItem.unitPrice);

    const grItem = await GoodsReceiptItem.create(
      { groupId: order.groupId, companyId: order.companyId, goodsReceiptId: goodsReceipt.id, purchaseOrderItemId: poItem.id, receivedQuantity: receivedQty },
      { transaction }
    );
    if (!firstGrItem) firstGrItem = grItem;

    // EST-TS/Three-way match: recebido > saldo restante do PO = over-receipt (OVER_RECEIPT).
    if (receivedQty > remaining) {
      discrepancies.push(
        await ReceiptDiscrepancy.create(
          { groupId: order.groupId, companyId: order.companyId, goodsReceiptItemId: grItem.id, discrepancyType: 'OVER_RECEIPT', expectedValue: remaining, receivedValue: receivedQty, status: 'OPEN' },
          { transaction }
        )
      );
    }

    // REVISÃO MARCO 7 (19/10/2026, B3): somava a quantidade física cheia, inclusive o excedente
    // ainda não decidido — rejeitado o excedente, o pedido continuava "recebido a mais". Agora só
    // o que coube no pedido conta como recebido; o excedente só soma se a divergência for ACEITA
    // (resolveDiscrepancy).
    poItem.receivedQuantity = Number(poItem.receivedQuantity) + cappedQtyForAmount;
    await poItem.save({ transaction });

    if (poItem.inventoryItemId && cappedQtyForAmount > 0) {
      inventoryReceiptItems.push({ inventoryItemId: poItem.inventoryItemId, quantity: cappedQtyForAmount, unitCost: poItem.unitPrice });
    }
  }
  expectedAmount = round2(expectedAmount);
  fullReceivedAmount = round2(fullReceivedAmount);

  // BUG REAL CORRIGIDO (auditoria "loop até secar", rodada 25, 2026-10-05): o contrato exige
  // three-way match "PO x receipt x invoice" — mas só existia PO x receipt (quantidade). Quando
  // o valor da nota fiscal é informado e diverge do valor esperado (soma unitPrice x
  // receivedQty de todas as linhas), abre uma divergência de PREÇO de verdade, no mesmo padrão
  // fail-closed de OVER_RECEIPT, em vez de aceitar silenciosamente qualquer valor de nota.
  if (invoiceTotalAmount != null && Math.abs(round2(invoiceTotalAmount) - fullReceivedAmount) > INVOICE_AMOUNT_TOLERANCE) {
    discrepancies.push(
      await ReceiptDiscrepancy.create(
        { groupId: order.groupId, companyId: order.companyId, goodsReceiptItemId: firstGrItem.id, discrepancyType: 'PRICE_MISMATCH', expectedValue: fullReceivedAmount, receivedValue: round2(invoiceTotalAmount), status: 'OPEN' },
        { transaction }
      )
    );
  }

  // Delega a baixa física real a inventory.receipts — nunca duplica a lógica de IN/saldo/custo.
  if (inventoryReceiptItems.length > 0) {
    // FIX (auditoria Marco 7 Compras E2E, 2026-10-18): o número da NF digitado no recebimento
    // de Compras nunca chegava ao recibo de inventário como `invoiceNumber` — o movimento de
    // estoque saía como "Recebimento de mercadoria." genérico, enquanto o fluxo de Estoque
    // mostra "Recebimento da nota fiscal nº ...". Propaga o número pra rastreabilidade
    // NF → movimento ficar idêntica nos dois fluxos.
    const inventoryReceipt = await createInventoryReceipt(
      { groupId: order.groupId, companyId: order.companyId, destinationLocationId, supplierPersonId: invoiceFingerprint ? order.supplierPersonId : null, invoiceNumber: invoiceFingerprint || null, invoiceFingerprint: invoiceFingerprint ? `${invoiceFingerprint}:po:${order.id}` : null, items: inventoryReceiptItems },
      actor.userId,
      transaction
    );
    const { reviewReceipt } = require('../inventory/receipts.service');
    await reviewReceipt(inventoryReceipt.id, actor.userId, order.groupId, order.companyId, transaction);
    await confirmInventoryReceipt(inventoryReceipt.id, actor, order.groupId, order.companyId, transaction);
    goodsReceipt.inventoryReceiptId = inventoryReceipt.id;
  }

  const allItemsFullyReceived = order.items.every((i) => Number(i.receivedQuantity) >= Number(i.quantity));
  order.status = allItemsFullyReceived ? 'RECEIVED' : 'OPEN';
  order.updatedBy = actor.userId || null;
  await order.save({ transaction });

  // FIX (auditoria Marco 7 Compras E2E, 2026-10-18): a requisição de compra ficava parada em
  // AWARDED ("Adjudicada") pra sempre — o recebimento total do PO não propagava nada pra
  // máquina de estados da requisição que originou tudo. Recebido tudo, a requisição vira
  // DELIVERED ("Entregue"), fechando o ciclo Solicitação → ... → Pedido → Recebimento.
  if (allItemsFullyReceived && order.purchaseRequestId) {
    const originRequest = await PurchaseRequest.findOne({ where: { id: order.purchaseRequestId, groupId: order.groupId, companyId: order.companyId }, transaction, lock: transaction.LOCK.UPDATE });
    if (originRequest && originRequest.status === 'AWARDED') {
      originRequest.status = 'DELIVERED';
      originRequest.updatedBy = actor.userId || null;
      await originRequest.save({ transaction });
    }
  }

  goodsReceipt.status = 'CONFIRMED';
  goodsReceipt.updatedBy = actor.userId || null;

  // BUG REAL CORRIGIDO (rodada 25): "invoice match = payable idempotente" era descrito no
  // comentário do fluxo (linha ~20 deste arquivo: "RECEIPT -> MATCH -> PAYABLE") mas nunca
  // implementado — nenhum lançamento financeiro era criado a partir do recebimento confirmado.
  // Usa o valor da nota fiscal quando informado (mais preciso — é o que a fornecedora cobra de
  // fato), senão o valor esperado calculado (PO x quantidade recebida). idempotencyKey por
  // goodsReceipt garante que reprocessar nunca duplica o payable.
  //
  // REVISÃO MARCO 7 (19/10/2026, B1/B2 — decisão conservadora, o caderno só diz "divergência abre
  // case" e "invoice match = payable idempotente"): o payable nascia com o valor CHEIO da NF. Isso
  // (B1) pagava o excedente duas vezes — a NF já o cobrava e o aceite do OVER_RECEIPT lançava outro
  // payable — e (B2) deixava o valor contestado pagável enquanto a divergência estava aberta.
  // Agora o payable nasce SEMPRE no valor do pedido para o que coube nele (expectedAmount) e,
  // havendo qualquer divergência aberta, nasce RETIDO (requiresManualReview — o Financeiro não
  // liquida nem libera por fora, ver financeAntifraud.clearManualReview). Cada decisão de
  // divergência recalcula o valor devido do recebimento inteiro (reconcileGoodsReceiptPayable) —
  // excedente aceito e diferença de preço aceita entram ali, uma única vez.
  const payableAmount = expectedAmount;
  if (payableAmount > 0) {
    const costCenter = await getOrCreateDefaultCostCenter(order.groupId, order.companyId, PROCUREMENT_COST_CENTER_CODE, 'Recebimentos de compras', transaction);
    const payable = await createFinancialEntry(
      {
        groupId: order.groupId,
        companyId: order.companyId,
        entryType: 'DEBIT',
        nature: 'PAYABLE',
        amount: payableAmount,
        description: `Recebimento de materiais — PO ${order.id}${invoiceFingerprint ? ` (NF ${invoiceFingerprint})` : ''}.`,
        idempotencyKey: `goods-receipt:${goodsReceipt.id}`,
        costCenterId: costCenter.id,
      },
      actor.userId,
      transaction
    );
    if (discrepancies.length > 0) await holdPayableForDiscrepancy(payable, transaction);
    goodsReceipt.financialEntryId = payable.id;
  }
  await goodsReceipt.save({ transaction });

  await registrarAuditoria({ groupId: order.groupId, companyId: order.companyId, actorUserId: actor.userId, action: 'GOODS_RECEIPT_CONFIRMED', entityType: 'GoodsReceipt', entityId: goodsReceipt.id,
    beforeJson: auditBefore,
    afterJson: {
      goodsReceiptId: goodsReceipt.id,
      goodsReceiptStatus: goodsReceipt.status,
      purchaseOrderStatus: order.status,
      destinationLocationId,
      invoiceTotalAmount: invoiceTotalAmount != null ? invoiceTotalAmount : 'Não informado',
      financialEntryId: goodsReceipt.financialEntryId || 'Sem lançamento (valor zero)',
      discrepancyCount: discrepancies.length,
      items: order.items.map((i) => ({ purchaseOrderItemId: i.id, quantity: i.quantity, receivedQuantity: i.receivedQuantity })),
    },
    reason: `Recebimento confirmado — ${discrepancies.length} divergência(s).` }, transaction);

  return { goodsReceipt, discrepancies };
}

// BUG REAL CORRIGIDO (auditoria "loop até secar", rodada 27, 2026-10-05): confirmGoodsReceipt
// cria o GoodsReceipt (com invoiceTotalAmount/financialEntryId, R25/R26), mas não existia
// NENHUM endpoint pra listar/consultar recebimentos depois — o front não tinha como mostrar o
// payable gerado nem o histórico de recebimentos de um PO, mesmo o dado estando correto no
// banco (mesma família de bug da R24, mas "não exposto" em vez de "não exibido").
async function listGoodsReceipts(groupId, companyId, transaction, { purchaseOrderId } = {}) {
  const where = { groupId, companyId };
  if (purchaseOrderId) where.purchaseOrderId = purchaseOrderId;
  return GoodsReceipt.findAll({ where, order: [['created_at', 'DESC']], limit: 1500, transaction });
}

async function listDiscrepancies(groupId, companyId, transaction, { status } = {}) {
  const where = { groupId, companyId };
  if (status) where.status = status;
  const discrepancies = await ReceiptDiscrepancy.findAll({ where, order: [['created_at', 'DESC']], limit: 1500, transaction });

  // FIX (auditoria Marco 7 "reconf", 18/10/2026): a listagem crua deixava duas linhas
  // "25 / 30 / Em aberto" indistinguíveis — sem pedido, item nem NF, só olhando o banco dava
  // pra saber qual era qual. Enriquece cada linha com a identificação de onde ela veio.
  const grItemIds = [...new Set(discrepancies.map((d) => d.goodsReceiptItemId).filter(Boolean))];
  if (grItemIds.length === 0) return discrepancies.map((d) => d.toJSON());

  const grItems = await GoodsReceiptItem.findAll({ where: { id: grItemIds }, transaction });
  const grIds = [...new Set(grItems.map((i) => i.goodsReceiptId))];
  const poItemIds = [...new Set(grItems.map((i) => i.purchaseOrderItemId).filter(Boolean))];
  const goodsReceipts = grIds.length ? await GoodsReceipt.findAll({ where: { id: grIds }, transaction }) : [];
  const poItems = poItemIds.length ? await PurchaseOrderItem.findAll({ where: { id: poItemIds }, transaction }) : [];
  const poIds = [...new Set(goodsReceipts.map((g) => g.purchaseOrderId).filter(Boolean))];
  const orders = poIds.length ? await PurchaseOrder.findAll({ where: { id: poIds }, transaction }) : [];
  const itemIds = [...new Set(poItems.map((i) => i.inventoryItemId).filter(Boolean))];
  const inventoryItems = itemIds.length ? await InventoryItem.findAll({ where: { id: itemIds }, attributes: ['id', 'name', 'sku', 'unitOfMeasure'], transaction }) : [];
  const supplierIds = [...new Set(orders.map((o) => o.supplierPersonId).filter(Boolean))];
  const suppliers = supplierIds.length ? await Person.findAll({ where: { id: supplierIds }, attributes: ['id', 'legalName'], transaction }) : [];

  const grItemById = new Map(grItems.map((i) => [i.id, i]));
  const grById = new Map(goodsReceipts.map((g) => [g.id, g]));
  const poItemById = new Map(poItems.map((i) => [i.id, i]));
  const orderById = new Map(orders.map((o) => [o.id, o]));
  const invItemById = new Map(inventoryItems.map((i) => [i.id, i]));
  const supplierById = new Map(suppliers.map((s) => [s.id, s]));

  return discrepancies.map((d) => {
    const row = d.toJSON();
    const grItem = grItemById.get(d.goodsReceiptItemId);
    const gr = grItem ? grById.get(grItem.goodsReceiptId) : null;
    const poItem = grItem ? poItemById.get(grItem.purchaseOrderItemId) : null;
    const order = gr ? orderById.get(gr.purchaseOrderId) : null;
    const invItem = poItem ? invItemById.get(poItem.inventoryItemId) : null;
    const supplier = order ? supplierById.get(order.supplierPersonId) : null;
    row.purchaseOrderId = order ? order.id : null;
    // O pedido de compra não tem número próprio: a identificação de negócio é a mesma da tela de
    // Pedidos (data de criação + valor comprometido), nunca o UUID.
    row.purchaseOrderCreatedAt = order ? order.get('created_at') : null;
    row.purchaseOrderAmount = order ? order.committedAmount : null;
    row.supplierName = supplier ? supplier.legalName : null;
    row.invoiceNumber = gr ? gr.invoiceFingerprint : null;
    row.itemName = invItem ? invItem.name : null;
    row.itemSku = invItem ? invItem.sku : null;
    row.itemUnit = invItem ? invItem.unitOfMeasure : null;
    // Quem registrou o recebimento não decide a própria divergência (regra no resolveDiscrepancy);
    // a tela usa isto para nem oferecer Aceitar/Rejeitar a essa pessoa.
    row.receivedByUserId = gr ? gr.createdBy : null;
    return row;
  });
}

// REVISÃO MARCO 7 (19/10/2026, B1/B2) — retenção do pagamento e valor devido do recebimento.
const PAYABLE_HOLD_REASON = 'Retido por Compras: divergência de recebimento em aberto — o pagamento só é liberado depois da decisão da divergência.';
const FINANCIAL_DISCREPANCY_TYPES = ['OVER_RECEIPT', 'PRICE_MISMATCH'];

async function holdPayableForDiscrepancy(entry, transaction) {
  if (entry.requiresManualReview) return;
  entry.requiresManualReview = true;
  entry.manualReviewReason = PAYABLE_HOLD_REASON;
  entry.manualReviewClearedAt = null;
  entry.manualReviewClearedBy = null;
  await entry.save({ transaction });
}

/**
 * Recalcula o valor devido de UM recebimento a partir das decisões das divergências e deixa um
 * único payable ativo com esse valor:
 *   devido = (o que coube no pedido × preço do pedido)
 *          + (excedentes ACEITOS × preço do pedido)
 *          + (NF − valor físico a preço de pedido, só se a divergência de PREÇO foi ACEITA)
 * Enquanto houver divergência OPEN, o payable atual fica retido e nada é recalculado. O valor de
 * um FinancialEntry nunca é editado (FIN-010): se mudar, estorna e cria outro.
 */
async function reconcileGoodsReceiptPayable(goodsReceipt, actor, transaction, triggerDiscrepancyId) {
  const grItems = await GoodsReceiptItem.findAll({ where: { goodsReceiptId: goodsReceipt.id }, transaction });
  const discrepancies = grItems.length
    ? await ReceiptDiscrepancy.findAll({ where: { goodsReceiptItemId: grItems.map((i) => i.id), discrepancyType: FINANCIAL_DISCREPANCY_TYPES, status: { [Op.ne]: 'CANCELED' } }, transaction })
    : [];
  const current = goodsReceipt.financialEntryId
    ? await FinancialEntry.findByPk(goodsReceipt.financialEntryId, { transaction, lock: transaction.LOCK.UPDATE })
    : null;
  const currentActive = current && !['REVERSED', 'CANCELLED'].includes(current.status) ? current : null;

  if (discrepancies.some((d) => d.status === 'OPEN')) {
    if (currentActive) await holdPayableForDiscrepancy(currentActive, transaction);
    return { held: true, financialEntryId: currentActive ? currentActive.id : null };
  }

  const poItems = await PurchaseOrderItem.findAll({ where: { id: [...new Set(grItems.map((i) => i.purchaseOrderItemId))] }, transaction });
  const poItemById = new Map(poItems.map((i) => [i.id, i]));
  let base = 0;
  let full = 0;
  let acceptedOver = 0;
  for (const grItem of grItems) {
    const unitPrice = Number(poItemById.get(grItem.purchaseOrderItemId)?.unitPrice || 0);
    const received = Number(grItem.receivedQuantity);
    const over = discrepancies.find((d) => d.discrepancyType === 'OVER_RECEIPT' && d.goodsReceiptItemId === grItem.id);
    const inOrder = over ? Number(over.expectedValue) : received;
    base += Math.max(inOrder, 0) * unitPrice;
    full += received * unitPrice;
    if (over && over.status === 'ACCEPTED') acceptedOver += (received - Math.max(inOrder, 0)) * unitPrice;
  }
  const price = discrepancies.find((d) => d.discrepancyType === 'PRICE_MISMATCH');
  const priceDelta = price && price.status === 'ACCEPTED' && goodsReceipt.invoiceTotalAmount != null
    ? Number(goodsReceipt.invoiceTotalAmount) - full
    : 0;
  const due = Math.max(round2(base + acceptedOver + priceDelta), 0);

  if (currentActive && Math.abs(round2(currentActive.amount) - due) < 0.005) {
    if (currentActive.requiresManualReview && currentActive.manualReviewReason === PAYABLE_HOLD_REASON) {
      currentActive.requiresManualReview = false;
      currentActive.manualReviewClearedAt = new Date();
      currentActive.manualReviewClearedBy = actor.userId || null;
      await currentActive.save({ transaction });
    }
    return { held: false, financialEntryId: currentActive.id, amount: due };
  }

  if (currentActive) {
    await reverseFinancialEntry(
      currentActive.id,
      `Valor a pagar do recebimento recalculado após decisão de divergência (de ${formatBRLText(Number(currentActive.amount))} para ${formatBRLText(due)}).`,
      actor.userId,
      transaction
    );
  }
  let newEntryId = null;
  if (due > 0) {
    const costCenter = await getOrCreateDefaultCostCenter(goodsReceipt.groupId, goodsReceipt.companyId, PROCUREMENT_COST_CENTER_CODE, 'Recebimentos de compras', transaction);
    const corrected = await createFinancialEntry(
      {
        groupId: goodsReceipt.groupId,
        companyId: goodsReceipt.companyId,
        entryType: 'DEBIT',
        nature: 'PAYABLE',
        amount: due,
        description: `Recebimento de materiais (valor após decisão das divergências)${goodsReceipt.invoiceFingerprint ? ` — NF ${goodsReceipt.invoiceFingerprint}` : ''}.`,
        idempotencyKey: `goods-receipt:${goodsReceipt.id}:reconciled:${triggerDiscrepancyId}`,
        costCenterId: costCenter.id,
      },
      actor.userId,
      transaction
    );
    newEntryId = corrected.id;
  }
  goodsReceipt.financialEntryId = newEntryId;
  goodsReceipt.updatedBy = actor.userId || null;
  await goodsReceipt.save({ transaction });
  return { held: false, financialEntryId: newEntryId, amount: due, previousEntryId: currentActive ? currentActive.id : null };
}

const DISCREPANCY_RESOLUTIONS = ['ACCEPTED', 'REJECTED'];

// BUG REAL CORRIGIDO (auditoria "loop até secar", rodada 12, 2026-10-05): o contrato diz que
// o three-way match "divergência abre case" — mas nada no sistema jamais fechava esse case.
// `status` tinha DEFAULT 'OPEN' na migration/model exatamente pra existir uma transição, só
// que nenhum serviço/endpoint fazia essa escrita. Mesma família de bug de R7/R9/R10/R11
// ("tabela/campo criado mas nunca manipulado depois da escrita inicial").
async function resolveDiscrepancy(discrepancyId, groupId, companyId, payload, actor, transaction) {
  const { resolution, notes } = payload || {};
  const normalized = String(resolution || '').toUpperCase();
  if (!DISCREPANCY_RESOLUTIONS.includes(normalized)) {
    throw AppError.badRequest(`"resolution" precisa ser um de: ${DISCREPANCY_RESOLUTIONS.join(', ')}.`, 'RECEIPT_DISCREPANCY_VALIDATION');
  }

  // BUG REAL CORRIGIDO (auditoria "loop até secar", rodada 41, 2026-10-05): faltava lock
  // pessimista aqui — inconsistente com o resto do arquivo (decidePurchaseRequest,
  // awardSupplierOffer, confirmGoodsReceipt já usam lock: transaction.LOCK.UPDATE). Duas
  // decisões concorrentes (ex.: ACCEPTED e REJECTED quase simultâneas) podiam ambas ler
  // status OPEN antes de qualquer commit e gravar decisões conflitantes (lost update), sem
  // nenhuma delas ser bloqueada com RECEIPT_DISCREPANCY_INVALID_STATUS como deveria.
  //
  // REVISÃO MARCO 7 (19/10/2026): ordem de lock RECEBIMENTO → DIVERGÊNCIA, a mesma de
  // cancelPurchaseOrder (pedido → recebimentos → divergências). Antes a divergência era travada
  // primeiro e o recebimento depois, ordem inversa à do cancelamento (risco de deadlock), e duas
  // decisões simultâneas de divergências do MESMO recebimento recalculavam o payable cada uma sem
  // enxergar a outra. Com o recebimento travado primeiro, a segunda decisão espera a primeira e
  // relê o estado já confirmado.
  const discrepancyProbe = await ReceiptDiscrepancy.findOne({ where: { id: discrepancyId, groupId, companyId }, attributes: ['id', 'goodsReceiptItemId'], transaction });
  if (!discrepancyProbe) throw AppError.notFound('Divergência não encontrada.', 'RECEIPT_DISCREPANCY_NOT_FOUND');
  const probeGrItem = discrepancyProbe.goodsReceiptItemId
    ? await GoodsReceiptItem.findByPk(discrepancyProbe.goodsReceiptItemId, { attributes: ['id', 'goodsReceiptId'], transaction })
    : null;
  if (probeGrItem) {
    await GoodsReceipt.findOne({ where: { id: probeGrItem.goodsReceiptId, groupId, companyId }, attributes: ['id'], transaction, lock: transaction.LOCK.UPDATE });
  }
  const discrepancy = await ReceiptDiscrepancy.findOne({ where: { id: discrepancyId, groupId, companyId }, transaction, lock: transaction.LOCK.UPDATE });
  if (!discrepancy) throw AppError.notFound('Divergência não encontrada.', 'RECEIPT_DISCREPANCY_NOT_FOUND');
  if (discrepancy.status !== 'OPEN') {
    throw AppError.conflict(`Divergência com status "${discrepancy.status}" já foi resolvida.`, 'RECEIPT_DISCREPANCY_INVALID_STATUS');
  }

  // FIX (auditoria Marco 7 "reconf", 18/10/2026): rejeitar uma divergência sem dizer o porquê
  // deixava a trilha muda — "Rejeitada" e nada mais. Mesmo princípio das demais decisões
  // documentadas do projeto (perda, prazo jurídico, reajuste): recusa exige justificativa.
  if (normalized === 'REJECTED' && !String(notes || '').trim()) {
    throw AppError.badRequest(
      'Rejeitar uma divergência exige uma justificativa ("notes").',
      'RECEIPT_DISCREPANCY_REJECTION_REASON_REQUIRED'
    );
  }

  // FIX (auditoria Marco 7 "reconf", 18/10/2026): o MESMO usuário que registrou o recebimento
  // podia aceitar o próprio excedente — sem segregação, quem recebe "a mais" valida a si
  // mesmo. Mesmo padrão maker-checker do resto do projeto (requisição, perda, aprovação
  // financeira): quem criou o recebimento não decide a divergência dele.
  const discrepancyGrItem = discrepancy.goodsReceiptItemId
    ? await GoodsReceiptItem.findByPk(discrepancy.goodsReceiptItemId, { transaction })
    : null;
  const discrepancyGoodsReceipt = discrepancyGrItem
    ? await GoodsReceipt.findByPk(discrepancyGrItem.goodsReceiptId, { transaction })
    : null;
  if (discrepancyGoodsReceipt && discrepancyGoodsReceipt.createdBy && actor.userId && discrepancyGoodsReceipt.createdBy === actor.userId) {
    throw AppError.forbidden(
      'Quem registrou o recebimento não pode decidir a própria divergência — peça a decisão a outra pessoa com permissão.',
      'RECEIPT_DISCREPANCY_SELF_RESOLUTION_BLOCKED'
    );
  }

  const beforeJson = discrepancy.toJSON();
  discrepancy.status = normalized;
  discrepancy.resolutionNotes = notes || null;
  discrepancy.resolvedByUserId = actor.userId || null;
  discrepancy.resolvedAt = new Date();
  await discrepancy.save({ transaction });

  // Efeito financeiro de PRICE_MISMATCH/OVER_RECEIPT: ver reconcileGoodsReceiptPayable (chamado
  // abaixo). Antes (rodada 26) a rejeição de preço estornava e recriava o payable aqui, e o aceite
  // do excedente lançava um payable SEPARADO — o que pagava o excedente duas vezes quando a NF já o
  // cobrava (revisão 19/10/2026, B1).
  // BUG REAL CORRIGIDO (over-receipt sem cap, 2026-10-08): `confirmGoodsReceipt` agora capa o
  // payable no saldo do PO (`expectedValue` aqui) quando `receivedQty > remaining` — o excedente
  // (`receivedValue - expectedValue`) nunca entra automaticamente no contas a pagar. Só quando o
  // excedente é ACEITO aqui (reconhecendo-o como válido — ex.: PO estava com saldo cadastrado
  // errado) é que o valor correspondente é lançado; se REJEITADO, nada financeiro é feito — o
  // excedente nunca é pago. Mesmo padrão de idempotência (idempotencyKey por discrepancy, nunca
  // duplica em retry) e de nunca editar `amount` de um FinancialEntry existente (FIN-010) já
  // usado acima para PRICE_MISMATCH.
  if (discrepancy.discrepancyType === 'OVER_RECEIPT' && normalized === 'ACCEPTED') {
    const grItem = await GoodsReceiptItem.findByPk(discrepancy.goodsReceiptItemId, { transaction });
    const goodsReceipt = grItem ? await GoodsReceipt.findByPk(grItem.goodsReceiptId, { transaction, lock: transaction.LOCK.UPDATE }) : null;
    const poItem = grItem ? await PurchaseOrderItem.findByPk(grItem.purchaseOrderItemId, { transaction }) : null;
    if (goodsReceipt && poItem) {
      const overQuantity = Number(discrepancy.receivedValue) - Number(discrepancy.expectedValue);
      const overAmount = round2(overQuantity * Number(poItem.unitPrice));
      const overItem = poItem.inventoryItemId
        ? await InventoryItem.findByPk(poItem.inventoryItemId, { attributes: ['name', 'unitOfMeasure'], transaction })
        : null;
      const overQtyText = formatQtyText(overQuantity, overItem?.unitOfMeasure);
      const invoiceText = goodsReceipt.invoiceFingerprint ? `NF nº ${goodsReceipt.invoiceFingerprint}` : 'recebimento sem NF';
      // O valor do excedente aceito entra no payable ÚNICO do recebimento (reconcileGoodsReceiptPayable
      // abaixo), nunca num segundo lançamento (B1). B3: o excedente aceito passa a contar como recebido.
      poItem.receivedQuantity = Number(poItem.receivedQuantity) + overQuantity;
      await poItem.save({ transaction });
      if (overAmount > 0) {
        discrepancy.resolutionNotes = `${discrepancy.resolutionNotes ? `${discrepancy.resolutionNotes} ` : ''}[excedente de ${formatBRLText(overAmount)} incluído no valor a pagar do recebimento]`;
        await discrepancy.save({ transaction });
      }
      // BUG REAL CORRIGIDO (auditoria Marco 7 Compras E2E, 2026-10-18): o excedente físico
      // também só entra no SALDO DE ESTOQUE aqui, na aceitação — confirmGoodsReceipt passou a
      // capar a entrada no saldo do PO (ver fix lá). Mesmo caminho delegado de lá
      // (inventory.receipts), nunca duplicando a lógica de IN/saldo/custo médio.
      if (overQuantity > 0 && poItem.inventoryItemId && goodsReceipt.destinationLocationId) {
        // FIX (auditoria Marco 7 "reconf", 18/10/2026): a entrada do excedente aceito saía
        // "Recebimento de mercadoria." genérico. O recibo complementar NÃO reivindica a NF de
        // novo (a trava de NF duplicada recusaria — e com razão, é a mesma nota); o motivo do
        // movimento cita a NF de origem explicitamente via confirmReceipt(..., { movementReason }).
        const overInventoryReceipt = await createInventoryReceipt(
          {
            groupId: goodsReceipt.groupId,
            companyId: goodsReceipt.companyId,
            destinationLocationId: goodsReceipt.destinationLocationId,
            invoiceFingerprint: null,
            items: [{ inventoryItemId: poItem.inventoryItemId, quantity: overQuantity, unitCost: poItem.unitPrice }],
          },
          actor.userId,
          transaction
        );
        const { reviewReceipt } = require('../inventory/receipts.service');
        await reviewReceipt(overInventoryReceipt.id, actor.userId, goodsReceipt.groupId, goodsReceipt.companyId, transaction);
        await confirmInventoryReceipt(overInventoryReceipt.id, actor, goodsReceipt.groupId, goodsReceipt.companyId, transaction, {
          movementReason: goodsReceipt.invoiceFingerprint
            ? `Excedente aceito — recebimento da nota fiscal nº ${goodsReceipt.invoiceFingerprint}.`
            : 'Excedente aceito — recebimento de mercadoria.',
        });
        discrepancy.resolutionNotes = `${discrepancy.resolutionNotes ? `${discrepancy.resolutionNotes} ` : ''}[excedente de ${overQtyText} incorporado ao estoque — entrada da ${invoiceText}]`;
        await discrepancy.save({ transaction });
      }
    }
  }

  // Trilha explícita da devolução: excedente REJEITADO nunca entrou no saldo (cap em
  // confirmGoodsReceipt) — registra na própria resolução que a diferença volta ao fornecedor.
  if (discrepancy.discrepancyType === 'OVER_RECEIPT' && normalized === 'REJECTED') {
    const rejectedOverQty = Number(discrepancy.receivedValue) - Number(discrepancy.expectedValue);
    if (rejectedOverQty > 0) {
      const rejectedGrItem = discrepancy.goodsReceiptItemId ? await GoodsReceiptItem.findByPk(discrepancy.goodsReceiptItemId, { transaction }) : null;
      const rejectedPoItem = rejectedGrItem ? await PurchaseOrderItem.findByPk(rejectedGrItem.purchaseOrderItemId, { transaction }) : null;
      const rejectedItem = rejectedPoItem?.inventoryItemId
        ? await InventoryItem.findByPk(rejectedPoItem.inventoryItemId, { attributes: ['unitOfMeasure'], transaction })
        : null;
      discrepancy.resolutionNotes = `${discrepancy.resolutionNotes ? `${discrepancy.resolutionNotes} ` : ''}[excedente de ${formatQtyText(rejectedOverQty, rejectedItem?.unitOfMeasure)} rejeitado — não entrou no estoque; devolução ao fornecedor]`;
      await discrepancy.save({ transaction });
    }
  }

  let payableReconciliation = null;
  if (['OVER_RECEIPT', 'PRICE_MISMATCH'].includes(discrepancy.discrepancyType) && discrepancyGoodsReceipt) {
    const lockedReceipt = await GoodsReceipt.findByPk(discrepancyGoodsReceipt.id, { transaction, lock: transaction.LOCK.UPDATE });
    payableReconciliation = await reconcileGoodsReceiptPayable(lockedReceipt, actor, transaction, discrepancy.id);
  }

  await registrarAuditoria(
    {
      groupId: discrepancy.groupId, companyId: discrepancy.companyId, actorUserId: actor.userId,
      action: 'procurement.receipt_discrepancy.resolve',
      entityType: 'ReceiptDiscrepancy', entityId: discrepancy.id,
      beforeJson, afterJson: { ...discrepancy.toJSON(), payableReconciliation },
      reason: `Divergência de recebimento resolvida como ${normalized}.`,
    },
    transaction
  );

  return discrepancy;
}

// --- Avaliação de fornecedor ---
async function evaluateSupplier(payload, actorUserId, transaction) {
  const { groupId, companyId, supplierPersonId, purchaseOrderId, score, notes } = payload;
  // BUG REAL CORRIGIDO (auditoria "loop até secar", rodada 59, 2026-10-06): guard sem
  // Number.isFinite — score:"NaN" não é null e Number(NaN)<1/Number(NaN)>5 são ambos false,
  // passando a validação e corrompendo getAverageScore (NaN se propaga pra toda média futura).
  if (!groupId || !companyId || !supplierPersonId || score == null || !Number.isFinite(Number(score)) || Number(score) < 1 || Number(score) > 5) {
    throw AppError.badRequest('"groupId", "companyId", "supplierPersonId" e "score" (1 a 5) são obrigatórios.', 'SUPPLIER_EVALUATION_VALIDATION');
  }
  return SupplierEvaluation.create(
    { groupId, companyId, supplierPersonId, purchaseOrderId: purchaseOrderId || null, score, notes: notes || null, createdBy: actorUserId || null },
    { transaction }
  );
}

// BUG REAL CORRIGIDO (auditoria "loop até secar", rodada 17, 2026-10-05): evaluateSupplier só
// gravava — não existia nenhuma leitura (endpoint, service, uso interno) da avaliação, apesar
// do contrato listar `supplier_evaluations` como parte do fluxo de Procurement. Mesma família
// de bug "dado gravado e nunca lido" das rodadas 7/8/9/10. `averageScore` é a agregação mais
// útil pra decidir um próximo AWARD — nota histórica do fornecedor, não só a lista crua.
// REVISÃO MARCO 7 (19/10/2026, B13): o where não tinha empresa — só o RLS protegia. Defesa em
// profundidade: grupo e empresa explícitos no filtro.
async function listSupplierEvaluations(groupId, companyId, transaction, { supplierPersonId } = {}) {
  if (!groupId || !companyId) throw AppError.badRequest('"groupId" e "companyId" são obrigatórios.', 'SUPPLIER_EVALUATION_VALIDATION');
  const where = { groupId, companyId };
  if (supplierPersonId) where.supplierPersonId = supplierPersonId;
  const evaluations = await SupplierEvaluation.findAll({ where, order: [['created_at', 'DESC']], transaction });
  const averageScore = evaluations.length > 0
    ? Math.round((evaluations.reduce((acc, e) => acc + Number(e.score), 0) / evaluations.length) * 100) / 100
    : null;
  return { evaluations, averageScore, count: evaluations.length };
}

// BUG REAL CORRIGIDO (auditoria contratual, 2026-10-07): contrato exige "Cancel/return =
// compensação" — não existia nenhum endpoint pra cancelar uma PO. Cancelar uma PO com itens
// ainda não totalmente recebidos precisa deixar rastro formal da parte que não vai mais chegar
// (UNDER_RECEIPT), em vez de simplesmente sumir com o saldo pendente do PO sem explicação —
// mesmo espírito fail-closed/auditável de OVER_RECEIPT e PRICE_MISMATCH já existentes. O que já
// foi fisicamente recebido/pago não é revertido aqui (reversão de estoque/financeiro já
// recebido é uma devolução de verdade, fora do mínimo contratual de "cancel/return = registrar
// a compensação", que é o que este fluxo cobre) — EXCETO o payable: ver fix abaixo (reauditoria
// 2026-10-08) para o caso RECEIVED com financialEntryId já criado.
const CANCELABLE_STATUSES = ['OPEN', 'RECEIVED'];

async function cancelPurchaseOrder(id, groupId, companyId, payload, actor, transaction) {
  const order = await PurchaseOrder.findOne({ where: { id, groupId, companyId }, transaction, lock: transaction.LOCK.UPDATE });
  if (!order) throw AppError.notFound('Pedido de compra não encontrado.', 'PURCHASE_ORDER_NOT_FOUND');
  if (!CANCELABLE_STATUSES.includes(order.status)) {
    throw AppError.conflict(`Pedido de compra com status "${order.status}" não pode ser cancelado.`, 'PURCHASE_ORDER_INVALID_TRANSITION');
  }

  const items = await PurchaseOrderItem.findAll({ where: { purchaseOrderId: order.id }, transaction });
  const auditBefore = {
    status: order.status,
    committedAmount: order.committedAmount,
    items: items.map((i) => ({ purchaseOrderItemId: i.id, quantity: i.quantity, receivedQuantity: i.receivedQuantity })),
  };
  const underReceivedItems = items.filter((i) => Number(i.receivedQuantity) < Number(i.quantity));

  // REVISÃO MARCO 7 (19/10/2026, B12/B3): divergências OVER_RECEIPT/PRICE_MISMATCH ainda abertas
  // de um pedido cancelado ficavam abertas para sempre (decisão sobre algo que não existe mais).
  // São encerradas como CANCELED. O status de cada excedente é lido ANTES (overStatusByGrItem) para
  // o estorno de estoque abaixo saber o que de fato entrou no saldo.
  const orderReceipts = await GoodsReceipt.findAll({ where: { purchaseOrderId: order.id }, transaction, lock: transaction.LOCK.UPDATE });
  const orderGrItems = orderReceipts.length
    ? await GoodsReceiptItem.findAll({ where: { goodsReceiptId: orderReceipts.map((g) => g.id) }, transaction })
    : [];
  const orderDiscrepancies = orderGrItems.length
    ? await ReceiptDiscrepancy.findAll({ where: { goodsReceiptItemId: orderGrItems.map((i) => i.id) }, transaction, lock: transaction.LOCK.UPDATE })
    : [];
  const overByGrItem = new Map(orderDiscrepancies.filter((d) => d.discrepancyType === 'OVER_RECEIPT').map((d) => [d.goodsReceiptItemId, { status: d.status, expectedValue: Number(d.expectedValue), receivedValue: Number(d.receivedValue) }]));
  const canceledDiscrepancyIds = [];
  for (const d of orderDiscrepancies) {
    if (d.status !== 'OPEN') continue;
    d.status = 'CANCELED';
    d.resolutionNotes = `${d.resolutionNotes ? `${d.resolutionNotes} ` : ''}[encerrada: pedido de compra cancelado]`;
    d.resolvedByUserId = actor.userId || null;
    d.resolvedAt = new Date();
     
    await d.save({ transaction });
    canceledDiscrepancyIds.push(d.id);
  }

  const discrepancies = [];
  for (const item of underReceivedItems) {
    const lastGrItem = await GoodsReceiptItem.findOne({
      where: { purchaseOrderItemId: item.id }, order: [['created_at', 'DESC']], transaction,
    });
    // UNDER_RECEIPT só tem onde pendurar (goodsReceiptItemId é obrigatório no schema) quando já
    // houve pelo menos um recebimento parcial do item; cancelamento sem nenhum recebimento ainda
    // não é discrepância de recebimento — é simplesmente um pedido que nunca chegou a ser
    // entregue, registrado só pelo status CANCELED + a auditoria abaixo.
    if (lastGrItem) {
      discrepancies.push(
        await ReceiptDiscrepancy.create(
          {
            groupId: order.groupId, companyId: order.companyId, goodsReceiptItemId: lastGrItem.id,
            discrepancyType: 'UNDER_RECEIPT', expectedValue: Number(item.quantity), receivedValue: Number(item.receivedQuantity),
            status: 'OPEN',
          },
          { transaction }
        )
      );
    }
  }

  // BUG REAL CORRIGIDO (reauditoria contratual/financeira, 2026-10-08): cancelar um PO que já
  // está RECEIVED (tem GoodsReceipt com financialEntryId criado, possivelmente já SETTLED) não
  // estornava o payable gerado em confirmGoodsReceipt — cancelar a PO não podia deixar a empresa
  // com um contas a pagar de uma compra que o próprio sistema está marcando como cancelada.
  // Mesmo padrão de estorno já usado em resolveDiscrepancy (PRICE_MISMATCH rejeitado): nunca edita
  // o valor de um FinancialEntry existente (FIN-010) — estorna via reverseFinancialEntry.
  // REVISÃO MARCO 7 (19/10/2026, B4): só o financialEntryId do recebimento era estornado — o
  // payable SEPARADO do excedente aceito (modelo antigo, idempotencyKey
  // goods-receipt:<id>:over-receipt-accepted:<divergência>) ficava a pagar de um pedido cancelado.
  // Agora estorna todo payable ativo nascido do recebimento (chave goods-receipt:<id>...), o que
  // cobre o payable único atual e qualquer lançamento legado.
  const reversedFinancialEntryIds = [];
  for (const goodsReceipt of orderReceipts) {
    const entries = await FinancialEntry.findAll({
      where: {
        nature: 'PAYABLE',
        status: { [Op.notIn]: ['REVERSED', 'CANCELLED'] },
        [Op.or]: [
          { idempotencyKey: { [Op.like]: `goods-receipt:${goodsReceipt.id}%` } },
          ...(goodsReceipt.financialEntryId ? [{ id: goodsReceipt.financialEntryId }] : []),
        ],
      },
      order: [['id', 'ASC']],
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    for (const entry of entries) {
       
      await reverseFinancialEntry(
        entry.id,
        `Pedido de compra ${order.id} cancelado — estorno do payable gerado no recebimento ${goodsReceipt.id}.`,
        actor.userId,
        transaction
      );
      reversedFinancialEntryIds.push(entry.id);
    }
  }

  // GAP REAL CORRIGIDO (auditoria contratual, 2026-10-08 — Anexo I, "Integração: cancel/return =
  // compensação"): cancelar uma PO só estornava o payable financeiro — se o material JÁ tinha
  // sido recebido (GoodsReceipt CONFIRMADO, saldo físico já somado ao estoque em
  // confirmGoodsReceipt), o material ficava fisicamente no estoque mesmo com a compra cancelada.
  // Gera um movimento OUT real (reaproveitando movements.service — nunca escreve em
  // stock_balances direto, EST-002) por item/local de CADA recebimento confirmado deste PO,
  // revertendo exatamente a quantidade FÍSICA recebida (receivedQuantity do GoodsReceiptItem,
  // não a quantidade do PO — difere em recebimento parcial), vinculado ao PO cancelado via
  // sourceType/sourceId. OUT (não ADJUSTMENT/LOSS) porque há origem física rastreável de sobra
  // (o próprio GoodsReceiptItem que gerou a entrada) — não é um ajuste discricionário sem
  // lastro, então não exige inventory:approve nem reason obrigatório (idempotencyKey ainda
  // garante que reprocessar o cancelamento nunca duplica o estorno). Se não há recebimento
  // confirmado (PO só OPEN sem nenhum GoodsReceipt, ou itens sem inventoryItemId — descrição
  // livre, sem controle físico), nada é estornado no estoque, como já era o comportamento.
  const reversedStockMovementIds = [];
  const confirmedReceiptsForStock = await GoodsReceipt.findAll({ where: { purchaseOrderId: order.id, status: 'CONFIRMED' }, transaction });

  // Resolução do responsável pelo cancelamento para rastreabilidade
  let cancelResponsiblePersonId = payload?.responsiblePersonId || null;
  if (!cancelResponsiblePersonId && actor?.userId) {
    const p = (await Person.findOne({ where: { id: actor.userId, groupId: order.groupId, companyId: order.companyId }, attributes: ['id'], transaction }))
      || (await Person.findOne({ where: { groupId: order.groupId, companyId: order.companyId }, attributes: ['id'], transaction }));
    if (p) cancelResponsiblePersonId = p.id;
  }
  if (!cancelResponsiblePersonId) cancelResponsiblePersonId = order.supplierPersonId || null;

  for (const goodsReceipt of confirmedReceiptsForStock) {
    let cancelStageId = payload?.stageId || null;
    let cancelProjectId = null;
    const destLoc = await InventoryLocation.findOne({ where: { id: goodsReceipt.destinationLocationId, groupId: order.groupId, companyId: order.companyId }, transaction });
    if (destLoc && destLoc.locationType === 'PROJECT_SITE' && destLoc.projectId) {
      cancelProjectId = destLoc.projectId;
      if (!cancelStageId) {
        const stg = await ProjectStage.findOne({ where: { projectId: destLoc.projectId }, order: [['orderIndex', 'ASC'], ['created_at', 'ASC']], transaction });
        if (stg) cancelStageId = stg.id;
      }
    }

    const grItems = await GoodsReceiptItem.findAll({ where: { goodsReceiptId: goodsReceipt.id }, transaction });
    for (const grItem of grItems) {
      const poItem = items.find((i) => i.id === grItem.purchaseOrderItemId);
      if (!poItem || !poItem.inventoryItemId) continue;
      // REVISÃO MARCO 7 (19/10/2026, B3): estornava grItem.receivedQuantity (físico cheio) — com o
      // excedente rejeitado (ou ainda aberto) ele nunca entrou no saldo, e o estorno tirava do
      // estoque o que não era deste pedido. Estorna só o que entrou: o que coube no pedido, mais o
      // excedente se (e somente se) foi ACEITO.
      const over = overByGrItem.get(grItem.id);
      const enteredQuantity = over && over.status !== 'ACCEPTED'
        ? Math.max(over.expectedValue, 0)
        : Number(grItem.receivedQuantity);
      if (!(enteredQuantity > 0)) continue;
      const reversalMovement = await recordMovement(
        {
          groupId: order.groupId,
          companyId: order.companyId,
          inventoryItemId: poItem.inventoryItemId,
          movementType: 'OUT',
          quantity: enteredQuantity,
          sourceLocationId: goodsReceipt.destinationLocationId,
          projectId: cancelProjectId || undefined,
          stageId: cancelStageId || undefined,
          responsiblePersonId: cancelResponsiblePersonId || undefined,
          sourceType: 'PURCHASE_ORDER_CANCEL',
          sourceId: order.id,
          reason: `Estorno de estoque — pedido de compra ${order.id} cancelado após recebimento confirmado (${goodsReceipt.id}).`,
          idempotencyKey: `po-cancel-stock-reversal:${order.id}:${grItem.id}`,
        },
        actor,
        transaction
      );
      reversedStockMovementIds.push(reversalMovement.id);
    }
  }

  order.status = 'CANCELED';
  order.updatedBy = actor.userId || null;
  await order.save({ transaction });

  // REVISÃO MARCO 7 (19/10/2026, B12): a requisição que originou o pedido ficava "Entregue"
  // (DELIVERED) ou "Adjudicada" (AWARDED) apontando para um pedido cancelado. Decisão conservadora
  // (o caderno não define): ela é ENCERRADA (CLOSED) — nunca volta sozinha a um estado que permita
  // nova compra; se o material ainda for necessário, abre-se uma requisição nova, com nova aprovação.
  let requestStatusChange = null;
  if (order.purchaseRequestId) {
    const originRequest = await PurchaseRequest.findOne({ where: { id: order.purchaseRequestId, groupId: order.groupId, companyId: order.companyId }, transaction, lock: transaction.LOCK.UPDATE });
    if (originRequest && ['DELIVERED', 'AWARDED'].includes(originRequest.status)) {
      requestStatusChange = { purchaseRequestId: originRequest.id, from: originRequest.status, to: 'CLOSED' };
      originRequest.status = 'CLOSED';
      originRequest.updatedBy = actor.userId || null;
      await originRequest.save({ transaction });
    }
  }

  await registrarAuditoria(
    {
      groupId: order.groupId, companyId: order.companyId, actorUserId: actor.userId,
      action: 'PURCHASE_ORDER_CANCELED', entityType: 'PurchaseOrder', entityId: order.id,
      beforeJson: auditBefore,
      afterJson: {
        status: order.status,
        committedAmount: order.committedAmount,
        underReceivedItemCount: underReceivedItems.length,
        discrepancyIds: discrepancies.map((d) => d.id),
        reversedFinancialEntryIds,
        reversedStockMovementIds,
        canceledDiscrepancyIds,
        requestStatusChange: requestStatusChange || 'Sem mudança na requisição',
      },
      reason: payload?.reason || `PO cancelada — ${underReceivedItems.length} item(ns) com saldo não recebido (compensação registrada)${reversedFinancialEntryIds.length > 0 ? `; payable(s) estornado(s): ${reversedFinancialEntryIds.join(', ')}` : ''}${reversedStockMovementIds.length > 0 ? `; estoque estornado via movimento(s): ${reversedStockMovementIds.join(', ')}` : ''}.`,
    },
    transaction
  );

  return { order, discrepancies, reversedStockMovementIds, reversedFinancialEntryIds, canceledDiscrepancyIds };
}

// --- Due diligence / qualificação de fornecedor ---
// Contrato (Anexo I): "Fornecedores: documentos/vigência; due diligence para alto risco".

// BUG REAL CORRIGIDO (reauditoria contratual, 2026-10-08 — due diligence bypass): com
// `highRisk:false`, o código recalculava `dueDiligenceStatus` pra 'NOT_REQUIRED'
// incondicionalmente — mesmo se o status atual fosse 'REJECTED' (decidido via
// `decideSupplierDueDiligence`, que exige `procurement:approve`). Isso permitia que um usuário
// com só `procurement:create` (esta rota exige apenas isso) rebaixasse `highRisk` e "desligasse"
// uma reprovação de due diligence sem nenhuma aprovação. Agora, downgrade de uma qualification
// REJECTED pra um estado que resultaria em NOT_REQUIRED só é aceito se `actor.canApprove`
// (mesmo padrão `canApprove` já usado em confirmGoodsReceipt/resolveDiscrepancy).
async function upsertSupplierQualification(payload, actorUserId, actor, transaction) {
  const { groupId, companyId, supplierPersonId, documentFileIds, validUntil, highRisk } = payload || {};
  if (!groupId || !companyId || !supplierPersonId) {
    throw AppError.badRequest('"groupId", "companyId" e "supplierPersonId" são obrigatórios.', 'SUPPLIER_QUALIFICATION_VALIDATION');
  }
  // BUG REAL CORRIGIDO (reauditoria contratual, 2026-10-08): `validUntil` nunca era validado como
  // data — uma string inválida ("2026-13-40", "amanhã", etc.) era persistida sem checagem e só
  // quebrava depois, no momento de comparar com `todayInSaoPaulo()` em awardSupplierOffer
  // (comparação de string "válida" contra lixo nunca dá o resultado fail-closed esperado).
  if (validUntil != null && validUntil !== '' && !isValidDateOnly(validUntil)) {
    throw AppError.badRequest('"validUntil" precisa ser uma data válida no formato "YYYY-MM-DD".', 'SUPPLIER_QUALIFICATION_VALIDATION');
  }

  if (Array.isArray(documentFileIds) && documentFileIds.length > 0) {
    const found = await File.count({ where: { id: documentFileIds, companyId }, transaction });
    if (found !== new Set(documentFileIds).size) {
      throw AppError.badRequest('Algum documento informado não existe nesta empresa.', 'SUPPLIER_QUALIFICATION_VALIDATION');
    }
  }

  let qualification = await SupplierQualification.findOne({ where: { companyId, supplierPersonId }, transaction, lock: transaction.LOCK.UPDATE });
  const auditBefore = qualification
    ? { documentFileIds: qualification.documentFileIds, validUntil: qualification.validUntil, highRisk: qualification.highRisk, dueDiligenceStatus: qualification.dueDiligenceStatus }
    : null;
  const isHighRisk = Boolean(highRisk);
  const fields = {
    documentFileIds: Array.isArray(documentFileIds) ? documentFileIds : (qualification?.documentFileIds || []),
    // `undefined` (campo ausente) mantém a vigência atual; `null`/"" explícito LIMPA a vigência —
    // antes, `validUntil || atual` tornava impossível remover uma vigência já cadastrada pela
    // tela de qualificação (o valor antigo voltava sempre).
    validUntil: validUntil !== undefined ? (validUntil || null) : (qualification?.validUntil || null),
    highRisk: isHighRisk,
    updatedBy: actorUserId || null,
  };

  if (!qualification) {
    qualification = await SupplierQualification.create(
      { groupId, companyId, supplierPersonId, ...fields, dueDiligenceStatus: isHighRisk ? 'PENDING' : 'NOT_REQUIRED', createdBy: actorUserId || null },
      { transaction }
    );
  } else {
    // Virar alto risco reabre a due diligence (nunca mantém um APPROVED antigo válido pra um
    // risco que acabou de ser identificado); deixar de ser alto risco zera a exigência.
    if (isHighRisk && qualification.dueDiligenceStatus !== 'APPROVED') fields.dueDiligenceStatus = 'PENDING';
    if (isHighRisk && !qualification.highRisk) fields.dueDiligenceStatus = 'PENDING';
    if (!isHighRisk) fields.dueDiligenceStatus = 'NOT_REQUIRED';

    // REVISÃO MARCO 7 (19/10/2026, B9): quem só cadastra (procurement:create) estendia a vigência
    // ou trocava os documentos de uma due diligence JÁ APROVADA, e a aprovação antiga continuava
    // valendo para o material novo. Segregação: mudança de vigência/documentos feita por quem não
    // aprova devolve a due diligence para PENDING — outra pessoa, com procurement:approve, decide.
    const sameDocuments = JSON.stringify([...(qualification.documentFileIds || [])].sort()) === JSON.stringify([...(fields.documentFileIds || [])].sort());
    const sameValidity = String(qualification.validUntil || '') === String(fields.validUntil || '');
    if (isHighRisk && qualification.dueDiligenceStatus === 'APPROVED' && !actor?.canApprove && (!sameDocuments || !sameValidity)) {
      fields.dueDiligenceStatus = 'PENDING';
      fields.approvedByUserId = null;
      fields.approvedAt = null;
    }

    // BUG REAL CORRIGIDO (due diligence bypass, 2026-10-08): se a qualification já estava
    // REJECTED (decisão só tomada por quem tem `procurement:approve`, via
    // `decideSupplierDueDiligence`) e esta chamada resultaria em NOT_REQUIRED (ou qualquer
    // mudança que não seja um simples update de documentos mantendo o highRisk=true), exige a
    // mesma alçada de aprovação — nunca permite que um `procurement:create` "desligue" uma
    // reprovação só mandando highRisk:false.
    if (qualification.dueDiligenceStatus === 'REJECTED' && fields.dueDiligenceStatus === 'NOT_REQUIRED' && !actor?.canApprove) {
      await registrarTentativaBloqueada(
        {
          groupId,
          companyId,
          actorUserId,
          action: 'procurement.supplier_qualification.upsert',
          entityType: 'SupplierQualification',
          entityId: qualification.id,
          beforeJson: qualification.toJSON(),
          reason: 'Tentativa de rebaixar highRisk de qualificação REJEITADA sem permissão de aprovação.',
        },
        transaction
      );
      throw AppError.conflict(
        'Esta qualificação de fornecedor foi REJEITADA em due diligence — rebaixar "highRisk" para desligar essa exigência requer permissão "procurement:approve".',
        'SUPPLIER_QUALIFICATION_DOWNGRADE_REQUIRES_APPROVAL'
      );
    }

    Object.assign(qualification, fields);
    await qualification.save({ transaction });
  }

  await registrarAuditoria(
    { groupId, companyId, actorUserId, action: 'SUPPLIER_QUALIFICATION_UPDATED', entityType: 'SupplierQualification', entityId: qualification.id,
      beforeJson: auditBefore || undefined,
      afterJson: { documentFileIds: qualification.documentFileIds, validUntil: qualification.validUntil, highRisk: qualification.highRisk, dueDiligenceStatus: qualification.dueDiligenceStatus },
      reason: `Documentos/vigência/risco atualizados (highRisk=${isHighRisk}).` },
    transaction
  );

  return qualification;
}

async function decideSupplierDueDiligence(id, groupId, companyId, payload, actor, transaction) {
  const { decision, notes } = payload || {};
  const normalized = String(decision || '').toUpperCase();
  if (!['APPROVED', 'REJECTED'].includes(normalized)) {
    throw AppError.badRequest('"decision" precisa ser "APPROVED" ou "REJECTED".', 'SUPPLIER_QUALIFICATION_VALIDATION');
  }

  const qualification = await SupplierQualification.findOne({ where: { id, groupId, companyId }, transaction, lock: transaction.LOCK.UPDATE });
  if (!qualification) throw AppError.notFound('Qualificação de fornecedor não encontrada.', 'SUPPLIER_QUALIFICATION_NOT_FOUND');
  if (!qualification.highRisk) {
    throw AppError.badRequest('Fornecedor não está marcado como alto risco — não exige due diligence.', 'SUPPLIER_QUALIFICATION_NOT_HIGH_RISK');
  }
  // BUG REAL CORRIGIDO (reauditoria contratual, 2026-10-08): não havia whitelist do status DE
  // ORIGEM — era possível re-decidir uma due diligence já decidida (APPROVED -> REJECTED ou
  // vice-versa) sem nenhuma trava, inclusive revertendo silenciosamente uma aprovação já usada
  // para adjudicar um PO. Só permite decidir a partir de PENDING, igual ao padrão de máquina de
  // estado do resto do módulo (decidePurchaseRequest, resolveDiscrepancy).
  if (qualification.dueDiligenceStatus !== 'PENDING') {
    throw AppError.conflict(
      `Due diligence já foi decidida (status atual: ${qualification.dueDiligenceStatus}) — não pode ser decidida novamente.`,
      'SUPPLIER_DUE_DILIGENCE_ALREADY_DECIDED'
    );
  }

  // REVISÃO MARCO 7 (19/10/2026, B9): quem cadastrou/alterou por último os documentos e a vigência
  // não decide a própria due diligence (maker-checker, mesmo padrão do resto de Compras).
  const registeredBy = qualification.updatedBy || qualification.createdBy;
  if (registeredBy && actor.userId && registeredBy === actor.userId) {
    throw AppError.forbidden(
      'Quem cadastrou os documentos e a vigência do fornecedor não pode decidir a própria due diligence — peça a decisão a outra pessoa com permissão.',
      'SUPPLIER_DUE_DILIGENCE_SELF_DECISION_BLOCKED'
    );
  }

  const auditBefore = { dueDiligenceStatus: qualification.dueDiligenceStatus, dueDiligenceNotes: qualification.dueDiligenceNotes, approvedByUserId: qualification.approvedByUserId, approvedAt: qualification.approvedAt };
  qualification.dueDiligenceStatus = normalized;
  qualification.dueDiligenceNotes = notes || null;
  qualification.approvedByUserId = actor.userId || null;
  qualification.approvedAt = new Date();
  qualification.updatedBy = actor.userId || null;
  await qualification.save({ transaction });

  await registrarAuditoria(
    { groupId: qualification.groupId, companyId: qualification.companyId, actorUserId: actor.userId, action: 'SUPPLIER_DUE_DILIGENCE_DECIDED', entityType: 'SupplierQualification', entityId: qualification.id,
      beforeJson: auditBefore,
      afterJson: { dueDiligenceStatus: qualification.dueDiligenceStatus, dueDiligenceNotes: qualification.dueDiligenceNotes, approvedByUserId: qualification.approvedByUserId, approvedAt: qualification.approvedAt },
      reason: `Due diligence ${normalized.toLowerCase()}.` },
    transaction
  );

  return qualification;
}

async function listSupplierQualifications(groupId, companyId, transaction, { supplierPersonId } = {}) {
  const where = { groupId, companyId };
  if (supplierPersonId) where.supplierPersonId = supplierPersonId;
  return SupplierQualification.findAll({ where, order: [['created_at', 'DESC']], limit: 1500, transaction });
}

module.exports = {
  createPurchaseRequest,
  getPurchaseRequest,
  listPurchaseRequests,
  decidePurchaseRequest,
  createQuotation,
  submitSupplierOffer,
  compareOffers,
  awardSupplierOffer,
  getPurchaseOrder,
  listPurchaseOrders,
  confirmGoodsReceipt,
  listGoodsReceipts,
  listDiscrepancies,
  resolveDiscrepancy,
  evaluateSupplier,
  listSupplierEvaluations,
  cancelPurchaseOrder,
  upsertSupplierQualification,
  decideSupplierDueDiligence,
  listSupplierQualifications,
};
