'use strict';

// M9-D440 guard_ai_output_requires_factual_validation (Guia §14: "Não deixar IA inventar imóvel"). Estática: a corrente de passos do pipeline exige o passo anterior com ok e a autopublicação exige
// checks_json.factual.ok = true. Dinâmica: o texto da NAY com área e vagas que o cadastro não tem fica em FACT_CHECK_FAILED e todas as tentativas de saltar o passo (marca, aprovação, agendamento,
// autopublicação) são recusadas, sem job nem status novo.
const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { sequelize } = require('../../../../src/models');
const { withRollbackTenantTransaction } = require('../../../testHelpers');
const { prepararTenants } = require('../../../helpers/marketingExecucao');
const fx = require('../../../helpers/m9d406Fixtures');
const nay = require('../../../../src/features/marketing/content/pipeline.nayPort');
const factual = require('../../../../src/features/marketing/content/pipeline.factualPort');
const service = require('../../../../src/features/marketing/content/content.service');
const policy = require('../../../../src/features/marketing/content/autopublish.policy');
const g = require('../../_helpers/mktGuardas');

const NOME = 'guard_ai_output_requires_factual_validation';
let tenant;
let reviewer;
before(async () => {
  ({ tenantA: tenant } = await prepararTenants());
  await withRollbackTenantTransaction(tenant, async (t) => { reviewer = (await fx.q(t, 'SELECT id FROM core.users WHERE id <> :me AND deleted_at IS NULL ORDER BY id LIMIT 1', { me: tenant.userId }))[0].id; });
});
after(async () => { await sequelize.close(); });
afterEach(() => { nay.clearNayDraftProvider(); factual.resetFactualValidator(); });

test('guard_ai_output_requires_factual_validation: a corrente de passos exige o passo anterior com ok e a autopublicação exige o factual ok', () => {
  g.assertSemViolacao(NOME);
});

test('guard_ai_output_requires_factual_validation: passo que deixa de exigir a validação factual é achado com arquivo e linha', () => {
  const copia = g.copiaDoModulo([{ arquivo: 'src/features/marketing/content/pipeline.core.js', de: "prereq: 'factual' }", para: "prereq: 'facts' }" }]);
  try {
    const achados = g.violacoesDe(NOME, copia);
    assert.equal(achados.length, 1);
    assert.deepEqual([achados[0].arquivo, achados[0].linha], ['content/pipeline.core.js', 19]);
  } finally { require('node:fs').rmSync(copia, { recursive: true, force: true }); }
});

test('guard_ai_output_requires_factual_validation: texto da NAY com dado que o cadastro não tem não avança por nenhum caminho', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const prop = await fx.seedProperty(t, tenant);
    await fx.q(t, 'UPDATE real_estate.properties SET area_total_m2 = NULL, parking_spots = NULL WHERE id = :id RETURNING id', { id: prop.id });
    const tpl = await fx.publishedTemplate(t, tenant);
    fx.registerSandboxNay(() => 'Casa de 120 m² com 2 vagas de garagem, em ótima localização.');
    const out = await service.createAndRun({ tenant, actor: tenant.userId, input: { type: 'NEW_PROPERTY', sourceEntityType: 'property', sourceEntityId: prop.id, templateId: tpl.id } }, fx.sameTx(t));
    const itemId = out.content.id;
    assert.equal(out.content.status, 'FACT_CHECK_FAILED');
    const ctx = { tenant, actor: tenant.userId, itemId, now: new Date() };
    const recusa = (e) => [409, 422].includes(e.statusCode) && /^MKT_/.test(e.code);

    await assert.rejects(service.applyTemplate(ctx, t), recusa, 'marca sem validação factual');
    await assert.rejects(service.requestApprovalIfRequired(ctx, t), recusa, 'pedido de aprovação sem validação');
    await assert.rejects(service.approve({ tenant, actor: reviewer, itemId, input: { decision: 'APPROVE' } }, t), recusa, 'aprovação humana sem validação');
    await assert.rejects(service.schedulePublication({ ...ctx, channels: ['SITE'], when: new Date(Date.now() + 4 * 3600 * 1000).toISOString() }, t), recusa, 'agendamento sem validação');

    const [item] = await fx.q(t, 'SELECT status, current_version_id FROM marketing.content_items WHERE id = :i', { i: itemId });
    assert.equal(item.status, 'FACT_CHECK_FAILED', 'o status não avançou');
    const [version] = await fx.q(t, 'SELECT * FROM marketing.content_versions WHERE id = :v', { v: item.current_version_id });
    assert.equal(version.checks_json.factual.ok, false);
    assert.ok(!version.checks_json.branding && !version.checks_json.approval, 'nenhum passo seguinte gravou');
    assert.equal(version.approved_hash, null);
    assert.equal((await fx.q(t, 'SELECT count(*)::int AS n FROM marketing.publication_jobs WHERE content_version_id = :v', { v: version.id }))[0].n, 0);
    const auto = await policy.evaluateAutopublish({ item: { ...item, id: itemId, type: 'NEW_PROPERTY', status: 'COMPLIANCE_CHECKED' }, version, tenant, transaction: t });
    assert.equal(auto.autopublish, false);
    assert.ok(auto.reasons.includes('FACTUAL_NOT_OK'), 'a autopublicação também recusa pelo factual');
  });
});

test('guard_ai_output_requires_factual_validation: texto que o cadastro sustenta avança até a aprovação humana', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const prop = await fx.seedProperty(t, tenant);
    const tpl = await fx.publishedTemplate(t, tenant);
    fx.registerSandboxNay();
    const out = await service.createAndRun({ tenant, actor: tenant.userId, input: { type: 'NEW_PROPERTY', sourceEntityType: 'property', sourceEntityId: prop.id, templateId: tpl.id } }, fx.sameTx(t));
    assert.equal(out.content.status, 'PENDING_APPROVAL');
    const [version] = await fx.q(t, 'SELECT checks_json FROM marketing.content_versions WHERE content_item_id = :i ORDER BY version_no DESC LIMIT 1', { i: out.content.id });
    assert.equal(version.checks_json.factual.ok, true);
  });
});
