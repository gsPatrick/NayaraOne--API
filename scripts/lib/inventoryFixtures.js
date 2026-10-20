'use strict';

/**
 * Fixtures de Estoque/Compras/Seguros/Patrimônio criadas pelos SERVIÇOS REAIS (mesmas regras,
 * locks e validações da aplicação), sempre com SET LOCAL de tenant (RLS real). Usadas pelo drill
 * de restore de Estoque/Compras (scripts/restoreDrill/seedInventoryFixtures.js), pelo teste de
 * carga (scripts/loadTestInventoryProcurement.js) e pelos failure drills
 * (test/inventory.failureDrills.test.js) — nunca contra o banco compartilhado (os chamadores
 * rodam dentro de um cluster descartável).
 */

const path = require('path');

const SRC = path.join(__dirname, '..', '..', 'src');
const req = (p) => require(path.join(SRC, p));

function load() {
  const models = req('models');
  return {
    models,
    sequelize: models.sequelize,
    itemsService: req('features/inventory/items.service'),
    movementsService: req('features/inventory/movements.service'),
    requisitionsService: req('features/inventory/requisitions.service'),
    assetsService: req('features/inventory/assets.service'),
    procurementService: req('features/procurement/procurement.service'),
    insuranceService: req('features/procurement/insurance.service'),
    filesService: req('features/files/files.service'),
  };
}

async function getSeedTenant(ctx) {
  const { sequelize, models } = ctx;
  const group = await models.Group.findOne({ where: { name: 'Nayara One — Grupo Dev' } });
  if (!group) throw new Error('Tenant de seed não encontrado (rode os seeds no banco descartável).');
  const company = await sequelize.transaction(async (transaction) => {
    await sequelize.query('SET LOCAL app.group_id = :g', { replacements: { g: group.id }, transaction });
    return models.Company.findOne({ where: { groupId: group.id, name: 'Nayara One — Empresa Dev' }, transaction });
  });
  const admin = await models.User.findOne({ where: { email: 'admin@nayaraone.dev' } });
  return { groupId: group.id, companyId: company.id, userId: admin.id };
}

/** Transação commitada com o mesmo SET LOCAL do tenant.middleware.js. */
async function inTenant(ctx, tenant, fn, userId) {
  const { sequelize } = ctx;
  const t = await sequelize.transaction();
  try {
    await sequelize.query('SET LOCAL app.group_id = :g', { replacements: { g: tenant.groupId }, transaction: t });
    await sequelize.query('SET LOCAL app.company_id = :c', { replacements: { c: tenant.companyId }, transaction: t });
    await sequelize.query('SET LOCAL app.user_id = :u', { replacements: { u: userId || tenant.userId }, transaction: t });
    const r = await fn(t);
    await t.commit();
    return r;
  } catch (err) {
    await t.rollback().catch(() => {});
    throw err;
  }
}

function suffix() {
  return `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
}

async function createUser(ctx, label) {
  const s = suffix();
  return ctx.models.User.create({ name: `Drill ${label} ${s}`, email: `drill-${label.toLowerCase().replace(/\W+/g, '-')}-${s}@nayaraone.dev`, passwordHash: 'x', status: 'ACTIVE' });
}

async function createPerson(ctx, tenant, t, legalName, personType = 'PJ') {
  return ctx.models.Person.create(
    { groupId: tenant.groupId, companyId: tenant.companyId, personType, legalName, createdBy: tenant.userId, updatedBy: tenant.userId },
    { transaction: t }
  );
}

async function createItem(ctx, tenant, t, name, extra = {}) {
  return ctx.itemsService.createItem(
    { groupId: tenant.groupId, companyId: tenant.companyId, name, sku: `DRL-${suffix()}`, unitOfMeasure: 'UN', ...extra },
    tenant.userId,
    t
  );
}

async function createWarehouse(ctx, tenant, t, name) {
  return ctx.itemsService.createLocation({ groupId: tenant.groupId, companyId: tenant.companyId, name, locationType: 'WAREHOUSE' }, tenant.userId, t);
}

async function move(ctx, tenant, t, fields) {
  return ctx.movementsService.recordMovement({ groupId: tenant.groupId, companyId: tenant.companyId, ...fields }, { userId: tenant.userId, canApprove: false }, t);
}

/**
 * Pedido de compra OPEN pelo fluxo real REQUEST→APPROVAL→RFQ→OFFER→AWARD. `approverId` decide a
 * requisição (quem cria não aprova). `lines` = [{ inventoryItemId, description, quantity, unitPrice }].
 */
async function createOpenPurchaseOrder(ctx, tenant, t, { supplierPersonId, approverId, lines }) {
  const { procurementService: ps } = ctx;
  const request = await ps.createPurchaseRequest(
    { groupId: tenant.groupId, companyId: tenant.companyId, items: lines.map((l) => ({ inventoryItemId: l.inventoryItemId, description: l.description, quantity: l.quantity })) },
    tenant.userId,
    t
  );
  await ps.decidePurchaseRequest(request.id, tenant.groupId, tenant.companyId, 'APPROVED', approverId, t);
  const quotation = await ps.createQuotation(request.id, tenant.groupId, tenant.companyId, tenant.userId, t);
  const offer = await ps.submitSupplierOffer(
    quotation.id, tenant.groupId, tenant.companyId,
    { supplierPersonId, items: request.items.map((it, i) => ({ purchaseRequestItemId: it.id, unitPrice: lines[i].unitPrice })) },
    t
  );
  const file = await ctx.filesService.uploadFile(
    {
      groupId: tenant.groupId,
      companyId: tenant.companyId,
      fileName: `doc-fornecedor-${Date.now()}.pdf`,
      mimeType: 'application/pdf',
      contentBase64: Buffer.from('DOCUMENTOS FORNECEDOR').toString('base64'),
      category: 'generic',
    },
    tenant.userId,
    t
  );
  await ps.upsertSupplierQualification(
    {
      groupId: tenant.groupId,
      companyId: tenant.companyId,
      supplierPersonId,
      documentFileIds: [file.id],
      validUntil: '2099-12-31',
      highRisk: false,
    },
    tenant.userId,
    { canApprove: true },
    t
  );
  const order = await ps.awardSupplierOffer(offer.id, tenant.groupId, tenant.companyId, tenant.userId, t);
  const items = await ctx.models.PurchaseOrderItem.findAll({ where: { purchaseOrderId: order.id }, order: [['created_at', 'ASC']], transaction: t });
  return { request, quotation, offer, order, items };
}

module.exports = { load, getSeedTenant, inTenant, suffix, createUser, createPerson, createItem, createWarehouse, move, createOpenPurchaseOrder };
