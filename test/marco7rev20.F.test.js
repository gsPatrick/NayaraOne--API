'use strict';

// Conferência da cliente (IA da Nayara, 20/10/2026) — lacunas M7-F01..F04 do Marco 7
// (Maturacao/REVISAO_MARCO7_19-10.md, seção D). Cada teste foi escrito ANTES da correção e
// falhava no código anterior. Duas camadas:
//   1. SERVIÇO com rollback (banco real, nada persiste) — roda sempre;
//   2. ROTA HTTP genérica (POST /inventory/movements e POST /assets/:id/loan), com app
//      real, JWT real e RLS real — grava fixtures, por isso SÓ roda em banco descartável:
//        node scripts/withDisposableDb.js -- node --test --test-concurrency=1 test/marco7rev20.F.test.js
//      Fora dele (sem DISPOSABLE_DB=1) os testes HTTP são pulados.
// Nos casos recusados, nada pode ser gravado: movimento, saldo e evento (outbox) permanecem
// exatamente como antes.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const DISPOSABLE = process.env.DISPOSABLE_DB === '1';
if (DISPOSABLE) {
  process.env.PORT = process.env.MARCO7_REV20_HTTP_PORT || '21620';
  require('../app');
}

const { sequelize, getSeedTenant, withRollbackTenantTransaction, withTenantTransaction, uniqueSuffix } = require('./testHelpers');
const { signAccessToken } = require('../src/utils/jwt');
const itemsService = require('../src/features/inventory/items.service');
const movementsService = require('../src/features/inventory/movements.service');
const assetsService = require('../src/features/inventory/assets.service');
const toolLoansService = require('../src/features/inventory/toolLoans.service');
const requisitionsService = require('../src/features/inventory/requisitions.service');
const projectsService = require('../src/features/construction/projects.service');
const projectStagesService = require('../src/features/construction/projectStages.service');
const { Person, InventoryMovement, InventoryStockBalance, OutboxEvent, InventoryToolLoan, Asset } = require('../src/models');
const AppError = require('../src/utils/AppError');

let tenant;
let baseUrl;
let token;

before(async () => {
  tenant = await getSeedTenant();
  if (DISPOSABLE) {
    token = signAccessToken({ sub: tenant.userId, group_id: tenant.groupId, company_id: tenant.companyId, roles: ['admin'], permissions: ['inventory:read', 'inventory:create', 'inventory:update'] });
    baseUrl = `http://127.0.0.1:${process.env.PORT}/api/v1`;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
});

after(async () => {
  await sequelize.close();
  if (DISPOSABLE) process.exit(0);
});

const withTenant = (f) => ({ groupId: tenant.groupId, companyId: tenant.companyId, ...f });
const admin = () => ({ userId: tenant.userId, canApprove: true });

function expectCode(code) {
  return (err) => {
    assert.ok(err instanceof AppError, `esperado AppError(${code}), recebido: ${err?.name} ${err?.code} ${err?.message}`);
    assert.equal(err.code, code, `código esperado ${code}, recebido ${err.code}: ${err.message}`);
    return true;
  };
}

async function person(t) {
  return Person.create({ groupId: tenant.groupId, companyId: tenant.companyId, personType: 'PF', legalName: `Resp rev20 ${uniqueSuffix()}`, createdBy: tenant.userId, updatedBy: tenant.userId }, { transaction: t });
}
async function item(t) {
  const s = uniqueSuffix();
  return itemsService.createItem(withTenant({ name: `HOMO QA rev20 ${s}`, sku: `REV20-${s}`, unitOfMeasure: 'UN' }), tenant.userId, t);
}
async function warehouse(t) {
  return itemsService.createLocation(withTenant({ name: `HOMO QA rev20 Almox ${uniqueSuffix()}`, locationType: 'WAREHOUSE' }), tenant.userId, t);
}
async function obra(t) {
  const project = await projectsService.createProject(withTenant({ name: `HOMO QA rev20 Obra ${uniqueSuffix()}` }), tenant.userId, t);
  const stage = await projectStagesService.createProjectStage(project.id, withTenant({ name: 'Etapa' }), tenant.userId, t);
  const site = await itemsService.createLocation(withTenant({ name: `HOMO QA rev20 Canteiro ${uniqueSuffix()}`, locationType: 'PROJECT_SITE', projectId: project.id }), tenant.userId, t);
  return { project, stage, site };
}
async function stockIn(t, itemId, locationId, quantity = 10) {
  return movementsService.recordMovement(withTenant({ inventoryItemId: itemId, movementType: 'IN', quantity, destinationLocationId: locationId }), admin(), t);
}

// Retrato dos efeitos: movimentos, saldo e eventos do item/empresa.
async function snapshot(t, itemId) {
  const opts = t ? { transaction: t } : {};
  const movements = await InventoryMovement.count({ where: { inventoryItemId: itemId }, ...opts });
  const balances = await InventoryStockBalance.findAll({ where: { inventoryItemId: itemId }, ...opts });
  const events = await OutboxEvent.count({ where: { companyId: tenant.companyId }, ...opts });
  return { movements, balance: balances.reduce((a, b) => a + Number(b.quantity), 0), events };
}

// =============================================================================================
// SERVIÇO (rollback)
// =============================================================================================

test('F01 serviço: projectId da obra B num canteiro da obra A é recusado, sem nenhum efeito', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const it = await item(t);
    const a = await obra(t);
    const b = await obra(t);
    await stockIn(t, it.id, a.site.id);
    const before = await snapshot(t, it.id);
    await assert.rejects(
      () => movementsService.recordMovement(withTenant({ inventoryItemId: it.id, movementType: 'IN', quantity: 3, destinationLocationId: a.site.id, projectId: b.project.id }), admin(), t),
      expectCode('INVENTORY_MOVEMENT_PROJECT_MISMATCH')
    );
    assert.deepEqual(await snapshot(t, it.id), before);
  });
});

test('F01 serviço: sem projectId o movimento usa a obra do canteiro; projectId igual ao do canteiro é aceito', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const it = await item(t);
    const a = await obra(t);
    const m1 = await movementsService.recordMovement(withTenant({ inventoryItemId: it.id, movementType: 'IN', quantity: 2, destinationLocationId: a.site.id }), admin(), t);
    assert.equal(m1.projectId, a.project.id);
    const m2 = await movementsService.recordMovement(withTenant({ inventoryItemId: it.id, movementType: 'IN', quantity: 2, destinationLocationId: a.site.id, projectId: a.project.id }), admin(), t);
    assert.equal(m2.projectId, a.project.id);
  });
});

test('F02 serviço: stageId da obra B com projectId/canteiro da obra A é recusado, sem nenhum efeito (OUT e IN)', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const it = await item(t);
    const resp = await person(t);
    const a = await obra(t);
    const b = await obra(t);
    await stockIn(t, it.id, a.site.id);
    const before = await snapshot(t, it.id);
    // OUT do canteiro da obra A (obra derivada do canteiro) com etapa de B
    await assert.rejects(
      () => movementsService.recordMovement(withTenant({ inventoryItemId: it.id, movementType: 'OUT', quantity: 1, sourceLocationId: a.site.id, stageId: b.stage.id, responsiblePersonId: resp.id }), admin(), t),
      expectCode('INVENTORY_MOVEMENT_STAGE_INVALID')
    );
    // IN no canteiro da obra A com etapa de B (antes a etapa só era conferida em OUT)
    await assert.rejects(
      () => movementsService.recordMovement(withTenant({ inventoryItemId: it.id, movementType: 'IN', quantity: 1, destinationLocationId: a.site.id, stageId: b.stage.id }), admin(), t),
      expectCode('INVENTORY_MOVEMENT_STAGE_INVALID')
    );
    // etapa inexistente
    await assert.rejects(
      () => movementsService.recordMovement(withTenant({ inventoryItemId: it.id, movementType: 'OUT', quantity: 1, sourceLocationId: a.site.id, stageId: '00000000-0000-4000-8000-000000000000', responsiblePersonId: resp.id }), admin(), t),
      expectCode('INVENTORY_MOVEMENT_STAGE_INVALID')
    );
    assert.deepEqual(await snapshot(t, it.id), before);
  });
});

test('F03 serviço: REQUISITION com sourceId nulo e responsável nulo é recusado, sem efeitos', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const it = await item(t);
    const wh = await warehouse(t);
    await stockIn(t, it.id, wh.id);
    const before = await snapshot(t, it.id);
    await assert.rejects(
      () => movementsService.recordMovement(withTenant({ inventoryItemId: it.id, movementType: 'OUT', quantity: 1, sourceLocationId: wh.id, sourceType: 'REQUISITION', sourceId: null, responsiblePersonId: null }), admin(), t),
      expectCode('INVENTORY_MOVEMENT_SOURCE_REQUIRED')
    );
    assert.deepEqual(await snapshot(t, it.id), before);
  });
});

test('F03 serviço: origem inexistente, de outro item, tipo desconhecido e sourceId em movimento manual são recusados; responsável de outra empresa também', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const it = await item(t);
    const other = await item(t);
    const wh = await warehouse(t);
    const resp = await person(t);
    await stockIn(t, it.id, wh.id);
    const a = await obra(t);
    const req = await requisitionsService.createRequisition(
      withTenant({ warehouseLocationId: wh.id, projectLocationId: a.site.id, projectId: a.project.id, stageId: a.stage.id, items: [{ inventoryItemId: other.id, quantity: 1 }] }),
      tenant.userId,
      t
    );
    const before = await snapshot(t, it.id);
    const base = { inventoryItemId: it.id, movementType: 'OUT', quantity: 1, sourceLocationId: wh.id, responsiblePersonId: resp.id };
    await assert.rejects(() => movementsService.recordMovement(withTenant({ ...base, sourceType: 'REQUISITION', sourceId: '00000000-0000-4000-8000-000000000000' }), admin(), t), expectCode('INVENTORY_MOVEMENT_SOURCE_INVALID'));
    await assert.rejects(() => movementsService.recordMovement(withTenant({ ...base, sourceType: 'REQUISITION', sourceId: req.id }), admin(), t), expectCode('INVENTORY_MOVEMENT_SOURCE_ITEM_MISMATCH'));
    await assert.rejects(() => movementsService.recordMovement(withTenant({ ...base, sourceType: 'BANANA', sourceId: req.id }), admin(), t), expectCode('INVENTORY_MOVEMENT_SOURCE_INVALID'));
    await assert.rejects(() => movementsService.recordMovement(withTenant({ ...base, sourceType: 'MANUAL', sourceId: req.id }), admin(), t), expectCode('INVENTORY_MOVEMENT_SOURCE_INVALID'));
    await assert.rejects(() => movementsService.recordMovement(withTenant({ ...base, sourceType: 'RECEIPT', sourceId: '00000000-0000-4000-8000-000000000000' }), admin(), t), expectCode('INVENTORY_MOVEMENT_SOURCE_INVALID'));
    await assert.rejects(() => movementsService.recordMovement(withTenant({ ...base, responsiblePersonId: '00000000-0000-4000-8000-000000000000' }), admin(), t), expectCode('INVENTORY_MOVEMENT_RESPONSIBLE_INVALID'));
    assert.deepEqual(await snapshot(t, it.id), before);
  });
});

test('F03 serviço (controle positivo): baixa pela requisição real, com responsável, grava o OUT ligado à origem', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const it = await item(t);
    const wh = await warehouse(t);
    const resp = await person(t);
    await stockIn(t, it.id, wh.id);
    const a = await obra(t);
    const req = await requisitionsService.createRequisition(
      withTenant({ warehouseLocationId: wh.id, projectLocationId: a.site.id, projectId: a.project.id, stageId: a.stage.id, items: [{ inventoryItemId: it.id, quantity: 2 }] }),
      tenant.userId,
      t
    );
    const mv = await movementsService.recordMovement(
      withTenant({ inventoryItemId: it.id, movementType: 'OUT', quantity: 2, sourceLocationId: wh.id, projectId: a.project.id, stageId: a.stage.id, sourceType: 'REQUISITION', sourceId: req.id, responsiblePersonId: resp.id }),
      admin(),
      t
    );
    assert.equal(mv.sourceId, req.id);
    assert.equal(mv.responsiblePersonId, resp.id);
  });
});

test('F04 serviço: empréstimo sem conditionOutCode é recusado; empréstimo, status e local não mudam', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const wh = await warehouse(t);
    const dest = await warehouse(t);
    const asset = await assetsService.createAsset(withTenant({ name: `Furadeira rev20 ${uniqueSuffix()}`, assetTag: `REV20-${uniqueSuffix()}`, currentLocationId: wh.id }), tenant.userId, t);
    const dueAt = new Date(Date.now() + 5 * 24 * 3600 * 1000).toISOString();
    for (const cond of [undefined, null, '']) {
      await assert.rejects(
        () => toolLoansService.loanTool(asset.id, { personUserId: tenant.userId, destinationLocationId: dest.id, dueAt, conditionOutCode: cond }, tenant.userId, tenant.groupId, tenant.companyId, t),
        expectCode('TOOL_LOAN_VALIDATION')
      );
    }
    assert.equal(await InventoryToolLoan.count({ where: { assetId: asset.id }, transaction: t }), 0);
    await asset.reload({ transaction: t });
    assert.equal(asset.status, 'AVAILABLE');
    assert.equal(asset.currentLocationId, wh.id);
    const ok = await toolLoansService.loanTool(asset.id, { personUserId: tenant.userId, destinationLocationId: dest.id, dueAt, conditionOutCode: 'OK' }, tenant.userId, tenant.groupId, tenant.companyId, t);
    assert.equal(ok.conditionOutCode, 'OK');
  });
});

// =============================================================================================
// ROTA HTTP genérica (banco descartável)
// =============================================================================================

const httpOpts = { skip: !DISPOSABLE && 'HTTP grava fixtures: rode com node scripts/withDisposableDb.js -- node --test test/marco7rev20.F.test.js' };

function call(method, path, body) {
  return fetch(`${baseUrl}${path}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: body !== undefined ? JSON.stringify(body) : undefined });
}

async function committedFixture() {
  return withTenantTransaction(tenant, async (t) => {
    const it = await item(t);
    const wh = await warehouse(t);
    const resp = await person(t);
    const a = await obra(t);
    const b = await obra(t);
    await stockIn(t, it.id, wh.id, 20);
    await stockIn(t, it.id, a.site.id, 20);
    return { it, wh, resp, a, b };
  });
}

async function expectRefused(path, body, code, itemId) {
  const before = await snapshot(null, itemId);
  const res = await call('POST', path, body);
  const json = await res.json();
  assert.equal(res.status, 400, `esperado 400, veio ${res.status}: ${JSON.stringify(json)}`);
  assert.equal(json.error?.code || json.code, code, JSON.stringify(json));
  assert.deepEqual(await snapshot(null, itemId), before, 'recusa não pode deixar movimento, saldo nem evento');
}

test('F01 HTTP: POST /inventory/movements com projectId da obra B no canteiro da obra A → 400 sem efeitos', httpOpts, async () => {
  const f = await committedFixture();
  await expectRefused('/inventory/movements', { inventoryItemId: f.it.id, movementType: 'IN', quantity: 1, destinationLocationId: f.a.site.id, projectId: f.b.project.id }, 'INVENTORY_MOVEMENT_PROJECT_MISMATCH', f.it.id);
});

test('F02 HTTP: POST /inventory/movements com stageId da obra B → 400 sem efeitos', httpOpts, async () => {
  const f = await committedFixture();
  await expectRefused('/inventory/movements', { inventoryItemId: f.it.id, movementType: 'OUT', quantity: 1, sourceLocationId: f.a.site.id, stageId: f.b.stage.id, responsiblePersonId: f.resp.id }, 'INVENTORY_MOVEMENT_STAGE_INVALID', f.it.id);
  await expectRefused('/inventory/movements', { inventoryItemId: f.it.id, movementType: 'IN', quantity: 1, destinationLocationId: f.a.site.id, stageId: f.b.stage.id }, 'INVENTORY_MOVEMENT_STAGE_INVALID', f.it.id);
  await expectRefused('/inventory/movements', { inventoryItemId: f.it.id, movementType: 'OUT', quantity: 1, sourceLocationId: f.wh.id, projectId: f.a.project.id, stageId: f.b.stage.id, responsiblePersonId: f.resp.id }, 'INVENTORY_MOVEMENT_STAGE_INVALID', f.it.id);
});

test('F03 HTTP: POST /inventory/movements com REQUISITION, sourceId nulo e responsável nulo → 400 sem efeitos; origem de outro item idem', httpOpts, async () => {
  const f = await committedFixture();
  await expectRefused('/inventory/movements', { inventoryItemId: f.it.id, movementType: 'OUT', quantity: 1, sourceLocationId: f.wh.id, sourceType: 'REQUISITION', sourceId: null, responsiblePersonId: null }, 'INVENTORY_MOVEMENT_SOURCE_REQUIRED', f.it.id);
  await expectRefused('/inventory/movements', { inventoryItemId: f.it.id, movementType: 'OUT', quantity: 1, sourceLocationId: f.wh.id, sourceType: 'REQUISITION', sourceId: '00000000-0000-4000-8000-000000000000', responsiblePersonId: f.resp.id }, 'INVENTORY_MOVEMENT_SOURCE_INVALID', f.it.id);
});

test('F04 HTTP: POST /assets/:id/loan sem conditionOutCode → 400, ferramenta continua disponível e sem empréstimo', httpOpts, async () => {
  const { asset, dest } = await withTenantTransaction(tenant, async (t) => {
    const wh = await warehouse(t);
    const dest = await warehouse(t);
    const asset = await assetsService.createAsset(withTenant({ name: `Furadeira HTTP rev20 ${uniqueSuffix()}`, assetTag: `REV20H-${uniqueSuffix()}`, currentLocationId: wh.id }), tenant.userId, t);
    return { asset, dest };
  });
  const dueAt = new Date(Date.now() + 5 * 24 * 3600 * 1000).toISOString();
  const res = await call('POST', `/assets/${asset.id}/loan`, { personUserId: tenant.userId, destinationLocationId: dest.id, dueAt });
  const json = await res.json();
  assert.equal(res.status, 400, JSON.stringify(json));
  assert.equal(json.error?.code || json.code, 'TOOL_LOAN_VALIDATION');
  assert.equal(await InventoryToolLoan.count({ where: { assetId: asset.id } }), 0);
  const fresh = await withTenantTransaction(tenant, (t) => Asset.findByPk(asset.id, { transaction: t }));
  assert.equal(fresh.status, 'AVAILABLE');
  const ok = await call('POST', `/assets/${asset.id}/loan`, { personUserId: tenant.userId, destinationLocationId: dest.id, dueAt, conditionOutCode: 'OK' });
  assert.equal(ok.status, 201);
});
