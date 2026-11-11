'use strict';

/**
 * Fechamento M5 (vistorias e prazos) — M5-A0092, livro §11 "NAY pode comparar entrada x saída e sugerir diferenças; humano valida
 * responsabilidade/cobrança" e JUR-008 "IA não decide direito". Infraestrutura de IA do Marco 9 com o PROVEDOR SIMULADO (sandbox):
 *  - IA ligada: run do orquestrador; o servidor chama legal.compareInspections; a resposta só afirma o que tem fonte (grounding: frase
 *    sem fonte é cortada); cada diferença vira recomendação PENDENTE; aceitar/rejeitar é a validação humana e não cria cobrança;
 *  - IA desligada: o caminho determinístico equivalente devolve a mesma comparação, sem texto de modelo e sem recomendação.
 * Fixtures em transação desfeita; a connection de IA ativa (commitada) é desligada no fim.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { withRollbackTenantTransaction, uniqueSuffix } = require('./testHelpers');
const { sequelize, prepararTenants } = require('./helpers/aiAgents');
const H = require('./marco9/_helpers/m9d037Agente');
const { conexaoAtiva } = require('./marco9/_helpers/m9d214Env');
const { upsertSetting } = require('../src/features/settings/settings.service');
const recommendations = require('../src/features/ai/recommendations');
const propertiesService = require('../src/features/properties/properties.service');
const inspectionsService = require('../src/modules/legal/inspections/inspection.service');
const { compareInspectionsWithNay } = require('../src/modules/legal/inspections/inspectionNay.service');
const { InspectionItem, CollectionCase, FinancialEntry, AiRecommendation } = require('../src/models');

let tenantA;
before(async () => { ({ tenantA } = await prepararTenants()); });
after(async () => {
  await sequelize.query("UPDATE integration.connections SET status = 'DISABLED' WHERE company_id = :c AND provider_code LIKE 'ai-%' AND status = 'ACTIVE'", { replacements: { c: tenantA.companyId } }).catch(() => {});
  await sequelize.close();
});

const PERMS = ['ai:use', 'legal:read'];

async function pair(t) {
  const base = { groupId: tenantA.groupId, companyId: tenantA.companyId };
  const sfx = uniqueSuffix();
  const p = await propertiesService.createProperty({ ...base, propertyType: 'RESIDENTIAL', title: `M5VP NAY ${sfx}`, internalCode: `M5VP-NAY-${sfx}` }, tenantA.userId, t);
  const entry = await inspectionsService.createInspection({ ...base, propertyId: p.id, inspectionType: 'ENTRY' }, tenantA.userId, t);
  const exit = await inspectionsService.createInspection({ ...base, propertyId: p.id, inspectionType: 'EXIT' }, tenantA.userId, t);
  await inspectionsService.addInspectionItem(entry.id, { itemName: 'Sala — piso', condition: 'GOOD' }, tenantA.userId, t);
  await inspectionsService.addInspectionItem(entry.id, { itemName: 'Cozinha — pia', condition: 'GOOD' }, tenantA.userId, t);
  await inspectionsService.addInspectionItem(exit.id, { itemName: 'Sala — piso', condition: 'DAMAGED', damageDescription: 'Riscos profundos', estimatedBudget: 450, responsibleParty: 'UNDETERMINED' }, tenantA.userId, t);
  await inspectionsService.addInspectionItem(exit.id, { itemName: 'Cozinha — pia', condition: 'GOOD' }, tenantA.userId, t);
  return { entry, exit };
}

test('M5-A0092/§11: a NAY compara entrada x saída pela infraestrutura de IA, com fonte; cada diferença vira sugestão que uma pessoa aceita ou rejeita', async () => {
  await conexaoAtiva(tenantA, 'AI');
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const c = await H.ativarAgente(tenantA, tx, 'NAY_JURIDICA', { perms: PERMS });
    await upsertSetting('ia.habilitada', true, c.ctx, c.ctx.userId, tx);
    await upsertSetting('ai.agents.enabled', '*', c.ctx, c.ctx.userId, tx);
    const { entry, exit } = await pair(tx);
    const itemsBefore = await InspectionItem.count({ transaction: tx });

    const out = await compareInspectionsWithNay(c.auth, { entryInspectionId: entry.id, exitInspectionId: exit.id }, tx, {
      orchestrator: { toolRegistry: c.registry, clock: H.FIXO },
      // Fixtura do provedor simulado: a 1ª frase cita a fonte; a 2ª (decide cobrança sem fonte) precisa ser cortada.
      instructionSuffix: '[[RESPOSTA:O piso da sala estava GOOD na entrada e DAMAGED na saída, com riscos profundos [1]. O locatário deve pagar R$ 9.999,00 pelo piso.]]',
    });
    assert.equal(out.mode, 'AI', JSON.stringify(out));
    assert.equal(out.requiresHumanValidation, true);
    assert.equal(out.nay.groundingStatus, 'GROUNDED', out.nay.answer);
    assert.match(out.nay.answer, /DAMAGED/);
    assert.doesNotMatch(out.nay.answer, /9\.999/, 'frase sem fonte não sai na resposta');
    assert.ok(out.nay.sources.some((s) => JSON.stringify(s).includes('Sala — piso')), 'a fonte é o item da vistoria');
    const [call] = await H.chamadas(out.nay.runId, tx);
    assert.equal(call.tool_name, 'legal.compareInspections');
    assert.equal(call.status, 'SUCCEEDED');
    assert.equal(out.nay.recommendations.length, 1, 'uma sugestão por item divergente');
    assert.equal(out.nay.recommendations[0].status, 'PENDING');
    assert.ok(out.comparison.divergences.some((d) => d.itemName === 'Sala — piso' && d.exitCondition === 'DAMAGED'));

    // Validação humana: uma pessoa aceita a sugestão; nada de cobrança nem de mudança na vistoria nasce disso.
    const entriesBefore = await FinancialEntry.count({ transaction: tx });
    const ctx = { groupId: tenantA.groupId, companyId: tenantA.companyId, userId: tenantA.userId, permissions: ['ai:approve', 'ai:read'], actorType: 'USER' };
    const { recommendation } = await recommendations.acceptRecommendation(ctx, out.nay.recommendations[0].id, {}, tx);
    assert.equal(recommendation.status !== 'PENDING', true);
    assert.equal(await FinancialEntry.count({ transaction: tx }), entriesBefore);
    assert.equal(await CollectionCase.count({ where: { contractId: null }, transaction: tx }), 0);
    assert.equal(await InspectionItem.count({ transaction: tx }), itemsBefore);
    assert.equal((await AiRecommendation.findByPk(out.nay.recommendations[0].id, { transaction: tx })).decidedByUserId, tenantA.userId);
  });
});

test('M5-A0092: com a IA desligada vale o caminho determinístico equivalente (mesma comparação, sem texto de modelo nem sugestão)', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const ctx = { groupId: tenantA.groupId, companyId: tenantA.companyId, userId: tenantA.userId };
    await upsertSetting('ia.habilitada', false, ctx, tenantA.userId, tx);
    const { entry, exit } = await pair(tx);
    const auth = { ...ctx, permissions: PERMS, roles: [] };
    const out = await compareInspectionsWithNay(auth, { entryInspectionId: entry.id, exitInspectionId: exit.id }, tx);
    assert.deepEqual([out.mode, out.reason, out.nay], ['DETERMINISTIC', 'AI_OFF', null]);
    assert.equal(out.comparison.totalDivergences, 1);
    assert.equal(out.comparison.divergences[0].itemName, 'Sala — piso');
    assert.deepEqual(out.comparison.recommendationIds, []);
    await assert.rejects(() => compareInspectionsWithNay({ ...auth, permissions: ['ai:use'] }, { entryInspectionId: entry.id, exitInspectionId: exit.id }, tx), (err) => err.statusCode === 403);
  });
});
