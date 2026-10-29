'use strict';

// M9-D007 — compatibilidade: a NAY de Estoque (inventoryNay.service) continua gerando, aprovando, rejeitando, silenciando e
// expirando sugestões com os estados que já usava, agora sob o gatilho de estados da recomendação.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix } = require('../../testHelpers');
const itemsService = require('../../../src/features/inventory/items.service');
const movementsService = require('../../../src/features/inventory/movements.service');
const nay = require('../../../src/features/inventory/inventoryNay.service');
const { AiRecommendation } = require('../../../src/models');
const { expectDbError } = require('../../helpers/aiRuns');

let tenant;
before(async () => { tenant = await getSeedTenant(); });
after(async () => { await sequelize.close(); });

const comTenant = (extra) => ({ groupId: tenant.groupId, companyId: tenant.companyId, ...extra });
const actor = () => ({ userId: tenant.userId, canApprove: true });

async function itemComSaldo(tx, saldo) {
  const sufixo = uniqueSuffix();
  const item = await itemsService.createItem(comTenant({ name: `D007 Item ${sufixo}`, sku: `D007-${sufixo}`, unitOfMeasure: 'UN', minimumQuantity: 10 }), tenant.userId, tx);
  const local = await itemsService.createLocation(comTenant({ name: `D007 Almox ${sufixo}`, locationType: 'WAREHOUSE' }), tenant.userId, tx);
  await movementsService.recordMovement(comTenant({ inventoryItemId: item.id, movementType: 'IN', quantity: saldo, destinationLocationId: local.id, sourceType: 'MANUAL' }), actor(), tx);
  return { item, local };
}
const sugestao = async (item, tx) => {
  const r = await nay.generatePurchaseSuggestions(comTenant({ inventoryItemId: item.id }), tenant.userId, tx);
  return { r, s: r.suggestions.find((x) => x.inventoryItemId === item.id) };
};

test('m9d007_inventory_nay_continua_funcionando', async () => {
  await withRollbackTenantTransaction(tenant, async (tx) => {
    // Aprovar: ACCEPTED com decisão e data preenchidas pelo gatilho (a NAY de Estoque não conhece as colunas novas).
    const a = await itemComSaldo(tx, 3);
    const { s: sa } = await sugestao(a.item, tx);
    assert.equal(sa.status, 'PENDING');
    const aprovada = await nay.approvePurchaseSuggestion(sa.id, tenant.groupId, tenant.companyId, { quantity: 7 }, { userId: tenant.userId }, tx);
    assert.equal(aprovada.suggestion.status, 'ACCEPTED');
    const [linhaA] = await AiRecommendation.findAll({ where: { id: sa.id }, transaction: tx });
    assert.equal(linhaA.get('status'), 'ACCEPTED');
    const [rowA] = (await sequelize.query('SELECT decision, decided_at, decided_by_user_id FROM ai.ai_recommendations WHERE id = :id', { replacements: { id: sa.id }, transaction: tx }))[0];
    assert.equal(rowA.decision, 'ACCEPTED'); assert.ok(rowA.decided_at); assert.equal(rowA.decided_by_user_id, tenant.userId);
    // Decidir de novo continua recusado pelo serviço dele, e o banco não deixa a decisão voltar atrás.
    await assert.rejects(nay.rejectPurchaseSuggestion(sa.id, tenant.groupId, tenant.companyId, { reason: 'x' }, { userId: tenant.userId }, tx), { code: 'INVENTORY_NAY_SUGGESTION_INVALID_TRANSITION' });
    await expectDbError(tx, "UPDATE ai.ai_recommendations SET status = 'PENDING' WHERE id = :id", { id: sa.id }, /AI_RECOMMENDATION_STATE/);

    // Rejeitar e a regra de silêncio: a mesma necessidade não volta enquanto a rejeição é recente.
    const b = await itemComSaldo(tx, 3);
    const { s: sb } = await sugestao(b.item, tx);
    const rejeitada = await nay.rejectPurchaseSuggestion(sb.id, tenant.groupId, tenant.companyId, { reason: 'sem verba' }, { userId: tenant.userId }, tx);
    assert.equal(rejeitada.status, 'REJECTED');
    const [rowB] = (await sequelize.query('SELECT decision, decided_at FROM ai.ai_recommendations WHERE id = :id', { replacements: { id: sb.id }, transaction: tx }))[0];
    assert.equal(rowB.decision, 'REJECTED'); assert.ok(rowB.decided_at);
    const depois = await sugestao(b.item, tx);
    assert.equal(depois.s, undefined, 'rejeição recente silencia a sugestão');
    assert.ok(depois.r.suppressedByRecentRejection >= 1);

    // Expirar: a necessidade sumiu no recálculo, a pendente vira EXPIRED sem ser "decidida".
    const c = await itemComSaldo(tx, 3);
    const { s: sc } = await sugestao(c.item, tx);
    await movementsService.recordMovement(comTenant({ inventoryItemId: c.item.id, movementType: 'IN', quantity: 100, destinationLocationId: c.local.id, sourceType: 'MANUAL' }), actor(), tx);
    const { r } = await sugestao(c.item, tx);
    assert.ok(r.expiredCount >= 1);
    const [rowC] = (await sequelize.query('SELECT status, decision FROM ai.ai_recommendations WHERE id = :id', { replacements: { id: sc.id }, transaction: tx }))[0];
    assert.equal(rowC.status, 'EXPIRED'); assert.equal(rowC.decision, null);
    await expectDbError(tx, "UPDATE ai.ai_recommendations SET status = 'PENDING' WHERE id = :id", { id: sc.id }, /AI_RECOMMENDATION_STATE/);
  });
});
