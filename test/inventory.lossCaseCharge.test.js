'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix } = require('./testHelpers');
const itemsService = require('../src/features/inventory/items.service');
const movementsService = require('../src/features/inventory/movements.service');
const assetsService = require('../src/features/inventory/assets.service');
const lossCasesService = require('../src/features/inventory/lossCases.service');
const filesService = require('../src/features/files/files.service');
const { FinancialEntry, ResultCenter, Person } = require('../src/models');
const AppError = require('../src/utils/AppError');

// GAP CORRIGIDO (auditoria de conformidade Marco 7, contrato §11): "Investigação e decisão
// humana determinam responsabilidade. Qualquer desconto financeiro segue regra/aprovação e
// Financeiro." decideLossCase não tinha nenhum caminho para gerar o desconto/cobrança ao
// responsável. Estes testes provam a integração real com o Financeiro.

let tenant;

before(async () => {
  tenant = await getSeedTenant();
});

after(async () => {
  await sequelize.close();
});

function withTenant(fields) {
  return { groupId: tenant.groupId, companyId: tenant.companyId, ...fields };
}

const approver = () => ({ userId: tenant.userId, canApprove: true });

async function evidence(transaction) {
  return filesService.uploadFile(
    withTenant({ fileName: 'evidencia-cobranca.jpg', mimeType: 'image/jpeg', contentBase64: Buffer.from(`EVID-${uniqueSuffix()}`).toString('base64'), category: 'generic' }),
    tenant.userId,
    transaction
  );
}

async function employee(transaction) {
  return Person.create(
    { groupId: tenant.groupId, companyId: tenant.companyId, personType: 'PF', legalName: `Colaborador Perda ${uniqueSuffix()}`, createdBy: tenant.userId, updatedBy: tenant.userId },
    { transaction }
  );
}

async function openAssetLossCase(transaction, extra = {}) {
  const suffix = uniqueSuffix();
  const asset = await assetsService.createAsset(withTenant({ name: `Furadeira ${suffix}`, assetTag: `CHG-${suffix}` }), tenant.userId, transaction);
  const file = await evidence(transaction);
  const lossCase = await lossCasesService.openLossCase(
    withTenant({ assetId: asset.id, context: 'Ferramenta quebrada por uso indevido.', evidenceFileIds: [file.id], ...extra }),
    tenant.userId,
    transaction
  );
  return { asset, lossCase };
}

test('§11: aprovar perda cobrando o responsável cria FinancialEntry RECEIVABLE/CREDIT real no Financeiro (valor = estimativa)', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const person = await employee(transaction);
    const { lossCase } = await openAssetLossCase(transaction, { responsiblePersonId: person.id, estimatedCost: 450.75 });

    const decided = await lossCasesService.decideLossCase(lossCase.id, tenant.groupId, tenant.companyId, 'APPROVED', approver(), transaction, { chargeResponsible: true });
    assert.equal(decided.status, 'APPROVED');

    const key = lossCasesService.lossChargeIdempotencyKey(lossCase.id);
    const entries = await FinancialEntry.findAll({ where: { idempotencyKey: key }, transaction });
    assert.equal(entries.length, 1);
    const entry = entries[0];
    assert.equal(entry.nature, 'RECEIVABLE', 'valor devido PELO responsável À empresa = a receber');
    assert.equal(entry.entryType, 'CREDIT');
    assert.equal(Number(entry.amount), 450.75);
    assert.equal(entry.status, 'PENDING', 'nasce pendente — cobrança/desconto segue o fluxo do Financeiro');
    assert.match(entry.description, new RegExp(person.legalName));

    const resultCenter = await ResultCenter.findByPk(entry.resultCenterId, { transaction });
    assert.equal(resultCenter.code, 'PATRIMONIO-PERDAS');

    const json = decided.toJSON();
    assert.equal(json.chargeFinancialEntry.id, entry.id);
    assert.equal(json.chargeFinancialEntry.amount, 450.75);

    const listed = await lossCasesService.listLossCases(tenant.groupId, tenant.companyId, transaction, {});
    const row = listed.find((lc) => lc.id === lossCase.id).toJSON();
    assert.equal(row.chargeFinancialEntry.id, entry.id, 'listagem expõe o vínculo caso→lançamento');
  });
});

test('§11: aprovador ajusta o valor e atribui o responsável na própria decisão (item de estoque)', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const suffix = uniqueSuffix();
    const item = await itemsService.createItem(withTenant({ name: `Cimento ${suffix}`, sku: `CHG-IT-${suffix}`, unitOfMeasure: 'SC' }), tenant.userId, transaction);
    const location = await itemsService.createLocation(withTenant({ name: `Depósito Cobrança ${suffix}`, locationType: 'WAREHOUSE' }), tenant.userId, transaction);
    await movementsService.recordMovement(
      withTenant({ inventoryItemId: item.id, movementType: 'IN', quantity: 10, destinationLocationId: location.id }),
      approver(),
      transaction
    );
    const file = await evidence(transaction);
    const lossCase = await lossCasesService.openLossCase(
      withTenant({ inventoryItemId: item.id, locationId: location.id, quantity: 2, context: 'Sacos rasgados no transporte.', evidenceFileIds: [file.id], estimatedCost: 100 }),
      tenant.userId,
      transaction
    );
    const person = await employee(transaction);

    const decided = await lossCasesService.decideLossCase(lossCase.id, tenant.groupId, tenant.companyId, 'APPROVED', approver(), transaction, {
      chargeResponsible: true,
      responsiblePersonId: person.id,
      chargeAmount: 60,
    });
    assert.equal(decided.responsiblePersonId, person.id, 'decisão humana determina a responsabilidade');
    assert.ok(decided.resultingMovementId, 'baixa LOSS continua sendo gerada');

    const entry = await FinancialEntry.findOne({ where: { idempotencyKey: lossCasesService.lossChargeIdempotencyKey(lossCase.id) }, transaction });
    assert.equal(Number(entry.amount), 60, 'valor ajustado pelo aprovador prevalece sobre a estimativa');
  });
});

test('§11: aprovar SEM cobrança ("ninguém teve culpa") não cria lançamento financeiro', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const person = await employee(transaction);
    const { lossCase } = await openAssetLossCase(transaction, { responsiblePersonId: person.id, estimatedCost: 300 });
    const decided = await lossCasesService.decideLossCase(lossCase.id, tenant.groupId, tenant.companyId, 'APPROVED', approver(), transaction, { chargeResponsible: false });
    assert.equal(decided.status, 'APPROVED');
    const count = await FinancialEntry.count({ where: { idempotencyKey: lossCasesService.lossChargeIdempotencyKey(lossCase.id) }, transaction });
    assert.equal(count, 0);
    assert.equal(decided.toJSON().chargeFinancialEntry, null);
  });
});

test('§11: cobrança exige perda aprovada, responsável real e valor > 0', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const person = await employee(transaction);

    const { lossCase: rejected } = await openAssetLossCase(transaction, { responsiblePersonId: person.id, estimatedCost: 100 });
    await assert.rejects(
      () => lossCasesService.decideLossCase(rejected.id, tenant.groupId, tenant.companyId, 'REJECTED', approver(), transaction, { chargeResponsible: true }),
      (err) => err instanceof AppError && err.code === 'LOSS_CASE_CHARGE_REQUIRES_APPROVAL'
    );

    const { lossCase: noResponsible } = await openAssetLossCase(transaction, { estimatedCost: 100 });
    await assert.rejects(
      () => lossCasesService.decideLossCase(noResponsible.id, tenant.groupId, tenant.companyId, 'APPROVED', approver(), transaction, { chargeResponsible: true }),
      (err) => err instanceof AppError && err.code === 'LOSS_CASE_CHARGE_RESPONSIBLE_REQUIRED'
    );
    await assert.rejects(
      () => lossCasesService.decideLossCase(noResponsible.id, tenant.groupId, tenant.companyId, 'APPROVED', approver(), transaction, { chargeResponsible: true, responsiblePersonId: '00000000-0000-4000-8000-000000000000' }),
      (err) => err instanceof AppError && err.code === 'LOSS_CASE_RESPONSIBLE_NOT_FOUND'
    );

    const { lossCase: noEstimate } = await openAssetLossCase(transaction, { responsiblePersonId: person.id });
    await assert.rejects(
      () => lossCasesService.decideLossCase(noEstimate.id, tenant.groupId, tenant.companyId, 'APPROVED', approver(), transaction, { chargeResponsible: true }),
      (err) => err instanceof AppError && err.code === 'LOSS_CASE_CHARGE_AMOUNT_REQUIRED'
    );
    await assert.rejects(
      () => lossCasesService.decideLossCase(noEstimate.id, tenant.groupId, tenant.companyId, 'APPROVED', approver(), transaction, { chargeResponsible: true, chargeAmount: -5 }),
      (err) => err instanceof AppError && err.code === 'LOSS_CASE_CHARGE_AMOUNT_INVALID'
    );

    // Nenhuma tentativa rejeitada pode ter deixado lançamento para trás.
    const keys = [rejected, noResponsible, noEstimate].map((lc) => lossCasesService.lossChargeIdempotencyKey(lc.id));
    assert.equal(await FinancialEntry.count({ where: { idempotencyKey: keys }, transaction }), 0);
  });
});

test('§11: cobrança exige inventory:approve (mesma alçada da decisão)', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const person = await employee(transaction);
    const { lossCase } = await openAssetLossCase(transaction, { responsiblePersonId: person.id, estimatedCost: 100 });
    await assert.rejects(
      () => lossCasesService.decideLossCase(lossCase.id, tenant.groupId, tenant.companyId, 'APPROVED', { userId: tenant.userId, canApprove: false }, transaction, { chargeResponsible: true }),
      (err) => err instanceof AppError && err.code === 'LOSS_CASE_APPROVAL_REQUIRED'
    );
  });
});

test('§11: cobrança é idempotente por caso — redecidir/reprocessar nunca duplica o lançamento', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const person = await employee(transaction);
    const { lossCase } = await openAssetLossCase(transaction, { responsiblePersonId: person.id, estimatedCost: 80 });
    await lossCasesService.decideLossCase(lossCase.id, tenant.groupId, tenant.companyId, 'APPROVED', approver(), transaction, { chargeResponsible: true });

    // Segunda decisão do mesmo caso é bloqueada pela máquina de estados...
    await assert.rejects(
      () => lossCasesService.decideLossCase(lossCase.id, tenant.groupId, tenant.companyId, 'APPROVED', approver(), transaction, { chargeResponsible: true }),
      (err) => err instanceof AppError && err.code === 'LOSS_CASE_INVALID_TRANSITION'
    );
    // ...e a chave de idempotência é única no Financeiro.
    const count = await FinancialEntry.count({ where: { idempotencyKey: lossCasesService.lossChargeIdempotencyKey(lossCase.id) }, transaction });
    assert.equal(count, 1);
  });
});

// Fiação HTTP (controller): o corpo da requisição POST /inventory/loss-cases/:id/decide precisa
// chegar ao service com os campos de cobrança — exercitado com req/res falsos dentro da mesma
// transação com rollback (nada persiste no banco compartilhado).
function callController(handler, req) {
  return new Promise((resolve, reject) => {
    const res = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(body) { resolve({ statusCode: this.statusCode, body: JSON.parse(JSON.stringify(body)) }); return this; },
    };
    handler(req, res, reject);
  });
}

test('§11 (HTTP): controller repassa chargeResponsible/responsiblePersonId/chargeAmount do corpo para a decisão', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const inventoryController = require('../src/features/inventory/inventory.controller');
    const person = await employee(transaction);
    const { lossCase } = await openAssetLossCase(transaction, { estimatedCost: 200 });

    const { statusCode, body } = await callController(inventoryController.decideLossCase, {
      params: { id: lossCase.id },
      body: { decision: 'APPROVED', chargeResponsible: true, responsiblePersonId: person.id, chargeAmount: 125.5 },
      auth: { userId: tenant.userId, groupId: tenant.groupId, companyId: tenant.companyId, permissions: ['inventory:approve'] },
      withTenantTransaction: (fn) => fn(transaction),
    });
    assert.equal(statusCode, 200);
    assert.equal(body.data.status, 'APPROVED');
    assert.equal(body.data.responsiblePersonId, person.id);
    assert.equal(body.data.chargeFinancialEntry.amount, 125.5);
    assert.equal(body.data.chargeFinancialEntry.nature, 'RECEIVABLE');
  });
});

test('§11: aprovar sem cobrança mantendo o responsável da abertura não revalida o cadastro (sem regressão)', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    // responsiblePersonId legado que não é uma Person (dado anterior a esta correção).
    const legacyId = '00000000-0000-4000-8000-0000000000aa';
    const { lossCase } = await openAssetLossCase(transaction, { responsiblePersonId: legacyId, estimatedCost: 10 });
    const decided = await lossCasesService.decideLossCase(lossCase.id, tenant.groupId, tenant.companyId, 'APPROVED', approver(), transaction, { responsiblePersonId: legacyId });
    assert.equal(decided.status, 'APPROVED');
    assert.equal(decided.responsiblePersonId, legacyId);
  });
});
