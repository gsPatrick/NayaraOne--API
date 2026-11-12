'use strict';

// Verificação independente do Marco 6 — M6-29 e M6-107 (Caderno §8 "aprovação conforme valor"; §9 "Desconto/
// ressarcimento passa por regra/aprovação e Financeiro"):
//  - alterar a alçada exige a permissão própria construction:approval_threshold:manage (construction:update não
//    basta) e MFA recente, e deixa auditoria com antes e depois;
//  - não há valor fixo no código: empresa sem alçada configurada não autoaprova nada;
//  - desconto de garantia acima da alçada não se autoaprova e quem propôs não aprova.
process.env.PORT = process.env.CONSTRUCTION_HTTP_TEST_PORT || '21593';
require('../app');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./testHelpers');
const { W, createMember, setThresholds, evidenceIds } = require('./constructionM6vFixture');
const { AuditLog, ApprovalThreshold, MaintenanceCase } = require('../src/models');
const { signAccessToken } = require('../src/utils/jwt');
const { upsertApprovalThreshold, getApprovalThreshold } = require('../src/features/construction/approvalThresholds.service');
const lossRecordsService = require('../src/features/construction/lossRecords.service');
const projectsService = require('../src/features/construction/projects.service');
const maintenanceCasesService = require('../src/features/construction/maintenanceCases.service');
const propertiesService = require('../src/features/properties/properties.service');

let tenant;
let baseUrl;
before(async () => {
  tenant = await H.getSeedTenant();
  baseUrl = `http://127.0.0.1:${process.env.PORT}/api/v1`;
});
after(async () => {
  await H.sequelize.close();
  process.exit(0); // app.js sobe o servidor HTTP real e não exporta o handle (mesmo padrão de construction.httpRoutes.test.js)
});

const tokenCom = (permissions) =>
  signAccessToken({ sub: tenant.userId, group_id: tenant.groupId, company_id: tenant.companyId, roles: ['m6v'], permissions });
const postAlcada = (token, body) =>
  fetch(`${baseUrl}/construction/approval-thresholds`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(body) });

test('M6-29: HTTP — construction:update não altera a alçada (403); com a permissão própria, sem MFA recente, recusa e nada muda', async () => {
  const antes = await H.withRollbackTenantTransaction(tenant, (t) => getApprovalThreshold(tenant.groupId, tenant.companyId, 'WARRANTY_RESOLUTION', t));
  const r1 = await postAlcada(tokenCom(['construction:read', 'construction:create', 'construction:update', 'construction:approve']), { context: 'WARRANTY_RESOLUTION', maxAutoApproveAmount: 900000000 });
  assert.equal(r1.status, 403);
  assert.equal((await r1.json()).error.code, 'PERMISSION_DENIED');
  const r2 = await postAlcada(tokenCom(['construction:read', 'construction:approval_threshold:manage']), { context: 'WARRANTY_RESOLUTION', maxAutoApproveAmount: 900000000 });
  assert.equal(r2.status, 403);
  assert.match((await r2.json()).error.code, /^MFA_(STEP_UP_REQUIRED|REQUIRED_NOT_ENABLED)$/);
  const depois = await H.withRollbackTenantTransaction(tenant, (t) => getApprovalThreshold(tenant.groupId, tenant.companyId, 'WARRANTY_RESOLUTION', t));
  assert.equal(depois, antes, 'alçada inalterada');
  const r3 = await fetch(`${baseUrl}/construction/approval-thresholds`, { headers: { authorization: `Bearer ${tokenCom(['construction:read'])}` } });
  assert.equal(r3.status, 200);
  assert.deepEqual((await r3.json()).data.map((a) => a.context), ['MATERIAL_LOSS', 'WARRANTY_RESOLUTION', 'INVENTORY_LOSS']);
});

test('M6-29: a rota de alçada exige a permissão própria e o MFA recente (montagem da rota)', () => {
  const router = require('../src/features/construction/construction.routes');
  const layer = router.stack.find((l) => l.route && l.route.path === '/construction/approval-thresholds' && l.route.methods.post);
  const handlers = layer.route.stack.map((s) => s.handle);
  assert.equal(handlers[0].requiredPermission, 'construction:approval_threshold:manage');
  assert.equal(handlers[1].name, 'requireRecentMfa');
});

test('M6-29: alterar a alçada grava auditoria com antes e depois; valor inválido é recusado', async () => {
  await H.withRollbackTenantTransaction(tenant, async (t) => {
    const primeira = await upsertApprovalThreshold(W(tenant, { context: 'MATERIAL_LOSS', maxAutoApproveAmount: 750 }), tenant.userId, t);
    const segunda = await upsertApprovalThreshold(W(tenant, { context: 'MATERIAL_LOSS', maxAutoApproveAmount: 1250.5 }), tenant.userId, t);
    assert.equal(primeira.id, segunda.id);
    const trilha = await AuditLog.findAll({ where: { entityId: segunda.id, action: 'construction.approval_threshold.update' }, order: [['occurred_at', 'DESC']], transaction: t });
    assert.ok(trilha.length >= 1);
    assert.equal(Number(trilha[0].beforeJson.maxAutoApproveAmount), 750);
    assert.equal(Number(trilha[0].afterJson.maxAutoApproveAmount), 1250.5);
    assert.equal(trilha[0].userId, tenant.userId);
    for (const ruim of ['Infinity', -1, 'abc']) {
      await assert.rejects(upsertApprovalThreshold(W(tenant, { context: 'MATERIAL_LOSS', maxAutoApproveAmount: ruim }), tenant.userId, t), { code: 'APPROVAL_THRESHOLD_VALIDATION' });
    }
    await assert.rejects(upsertApprovalThreshold(W(tenant, { context: 'QUALQUER', maxAutoApproveAmount: 1 }), tenant.userId, t), { code: 'APPROVAL_THRESHOLD_VALIDATION' });
  });
});

test('M6-96: sem alçada configurada não há valor fixo no código — perda de qualquer valor aguarda aprovação', async () => {
  await H.withRollbackTenantTransaction(tenant, async (t) => {
    await ApprovalThreshold.destroy({ where: { companyId: tenant.companyId, context: 'MATERIAL_LOSS' }, transaction: t });
    assert.equal(await getApprovalThreshold(tenant.groupId, tenant.companyId, 'MATERIAL_LOSS', t), 0);
    const obra = await projectsService.createProject(W(tenant, { name: `Obra ${H.uniqueSuffix()}` }), tenant.userId, t);
    const perda = await lossRecordsService.createLossRecord(obra.id, W(tenant, { materialDescription: 'Cimento', quantity: 1, estimatedValue: 5, reason: 'Quebra', idempotencyKey: `m6v-${H.uniqueSuffix()}` }), tenant.userId, t);
    assert.equal(perda.status, 'PENDING_APPROVAL');
    await setThresholds(tenant, t, { MATERIAL_LOSS: 10 });
    const dentro = await lossRecordsService.createLossRecord(obra.id, W(tenant, { materialDescription: 'Areia', quantity: 1, estimatedValue: 5, reason: 'Quebra', idempotencyKey: `m6v-${H.uniqueSuffix()}` }), tenant.userId, t);
    assert.equal(dentro.status, 'APPROVED');
  });
});

test('M6-107: desconto de garantia acima da alçada não se autoaprova e quem propôs não aprova; outra pessoa aprova', async () => {
  await H.withRollbackTenantTransaction(tenant, async (t) => {
    await setThresholds(tenant, t, { WARRANTY_RESOLUTION: 1000 });
    const imovel = await propertiesService.createProperty(W(tenant, { title: `Imóvel ${H.uniqueSuffix()}`, internalCode: `M6V-${H.uniqueSuffix()}`, propertyType: 'RESIDENTIAL' }), tenant.userId, t);
    const obra = await projectsService.createProject(W(tenant, { name: `Obra ${H.uniqueSuffix()}` }), tenant.userId, t);
    const chamado = await maintenanceCasesService.createMaintenanceCase(W(tenant, { propertyId: imovel.id, projectId: obra.id, description: 'Infiltração', severity: 'HIGH', beforeMediaFileIds: await evidenceIds(tenant, t) }), tenant.userId, t);
    const proposta = await maintenanceCasesService.proposeWarrantyResolution(chamado.id, { resolutionType: 'DISCOUNT', resolutionAmount: 50000 }, tenant.userId, t);
    assert.equal(proposta.resolutionStatus, 'PENDING_APPROVAL');
    assert.equal(proposta.resolutionProposedByUserId, tenant.userId);
    assert.equal(proposta.resolutionFinancialEntryId, null, 'sem lançamento antes da aprovação');
    await assert.rejects(maintenanceCasesService.approveWarrantyResolution(chamado.id, tenant.userId, t), { code: 'WARRANTY_RESOLUTION_SELF_APPROVAL' });
    assert.equal((await MaintenanceCase.findByPk(chamado.id, { transaction: t })).resolutionStatus, 'PENDING_APPROVAL');
    const aprovador = await createMember(tenant, t);
    const aprovada = await maintenanceCasesService.approveWarrantyResolution(chamado.id, aprovador.id, t);
    assert.equal(aprovada.resolutionStatus, 'APPROVED');
    assert.equal(aprovada.resolutionApprovedByUserId, aprovador.id);
    assert.ok(aprovada.resolutionFinancialEntryId);
  });
});
