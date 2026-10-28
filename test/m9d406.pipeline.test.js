'use strict';

// M9-D406 — pipeline do conteúdo: fonte -> rascunho NAY -> validação -> marca -> compliance -> aprovação -> agendamento.
// Postgres real, role de runtime (RLS FORCE), transação com rollback. Só em banco descartável (o .env aponta para a homologação remota):
// node scripts/withDisposableDb.js --port <porta> -- ... NODE_ENV=test node --test --test-concurrency=1 test/m9d406.pipeline.test.js

const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { sequelize } = require('../src/models');
const { withRollbackTenantTransaction } = require('./testHelpers');
const { prepararTenants } = require('./helpers/marketingExecucao');
const fx = require('./helpers/m9d406Fixtures');
const service = require('../src/modules/marketing/content/content.service');
const nay = require('../src/modules/marketing/content/pipeline.nayPort');
const factual = require('../src/modules/marketing/content/pipeline.factualPort');
const { parseWhen } = require('../src/modules/marketing/content/pipeline.time');
const { upsertSetting } = require('../src/features/settings/settings.service');

let tenant;
let reviewer;
before(async () => {
  ({ tenantA: tenant } = await prepararTenants());
  // outro usuário real da empresa (quem aprova não é quem gerou)
  await withRollbackTenantTransaction(tenant, async (t) => {
    const rows = await fx.q(t, 'SELECT id FROM core.users WHERE id <> :me AND deleted_at IS NULL ORDER BY id LIMIT 1', { me: tenant.userId });
    reviewer = rows[0] && rows[0].id;
  });
  assert.ok(reviewer, 'o seed precisa ter um segundo usuário');
});
after(async () => { await sequelize.close(); });
afterEach(() => { nay.clearNayDraftProvider(); factual.resetFactualValidator(); });

const run = (t, input, extra = {}) => service.createAndRun({ tenant, actor: tenant.userId, input, ...extra }, fx.sameTx(t));
const approve = (t, itemId, input = {}) => service.approve({ tenant, actor: reviewer, itemId, input }, t);
const schedule = (t, itemId, body, now) => service.schedule({ tenant, actor: reviewer, itemId, now, ...body }, t);
const rejectsCode = (promise, status, code) => assert.rejects(promise, (e) => e.statusCode === status && e.code === code, `esperava ${status} ${code}`);
const versionsOf = (t, itemId) => fx.versionsOf(t, itemId);

test('pipeline_feliz_ate_agendamento', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const prop = await fx.seedProperty(t, tenant);
    const tpl = await fx.publishedTemplate(t, tenant);
    const calls = fx.registerSandboxNay();
    const out = await run(t, { type: 'NEW_PROPERTY', sourceEntityType: 'property', sourceEntityId: prop.id, templateId: tpl.id });
    assert.equal(out.created, true);
    assert.equal(out.content.status, 'PENDING_APPROVAL');
    assert.equal(calls.length, 1);
    assert.deepEqual(Object.keys(calls[0]).sort(), ['brandContext', 'contentType', 'facts']); // a NAY recebe só os fatos
    assert.equal(out.content.currentVersion.modelName, 'sandbox-m9d406');
    assert.match(out.content.currentVersion.body.renderizado, /Novo imóvel em Jardim Europa/);

    const approved = await approve(t, out.content.id);
    assert.equal(approved.status, 'APPROVED');
    assert.match(approved.approvedHash, /^[0-9a-f]{64}$/);

    const when = fx.inHours(2);
    const scheduled = await schedule(t, out.content.id, { channels: ['INSTAGRAM', 'SITE'], when: when.toISOString() });
    assert.equal(scheduled.status, 'SCHEDULED');
    assert.equal(scheduled.jobs.length, 2);
    const timeline = await service.getContent(tenant, out.content.id, t);
    assert.equal(timeline.status, 'SCHEDULED');
    assert.deepEqual(timeline.jobs.map((j) => [j.channel, j.status]), [['INSTAGRAM', 'PENDING'], ['SITE', 'PENDING']]);
    const [job] = await fx.q(t, 'SELECT idempotency_key FROM marketing.publication_jobs WHERE id = :id', { id: scheduled.jobs[0].id });
    assert.match(job.idempotency_key, /^pub:[0-9a-f-]{36}:INSTAGRAM:/);

    // reagendar o mesmo instante e canais: replay, nenhum job a mais
    const again = await schedule(t, out.content.id, { channels: ['INSTAGRAM', 'SITE'], when: when.toISOString() });
    assert.equal(again.replay, true);
    assert.equal((await service.getContent(tenant, out.content.id, t)).jobs.length, 2);
  });
});

test('cada_passo_grava_checks_json', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const prop = await fx.seedProperty(t, tenant);
    const tpl = await fx.publishedTemplate(t, tenant);
    fx.registerSandboxNay();
    const { content } = await run(t, { type: 'NEW_PROPERTY', sourceEntityType: 'property', sourceEntityId: prop.id, templateId: tpl.id });
    await approve(t, content.id);
    await schedule(t, content.id, { channels: ['SITE'], when: fx.inHours(3).toISOString() });
    const timeline = await service.getContent(tenant, content.id, t);
    assert.deepEqual(Object.keys(timeline.checks).sort(), ['approval', 'branding', 'compliance', 'facts', 'factual', 'schedule']);
    for (const [step, check] of Object.entries(timeline.checks)) {
      assert.equal(check.ok, true, step);
      assert.ok(!Number.isNaN(Date.parse(check.at)), `${step}.at`);
      assert.equal(typeof check.detalhes, 'object', `${step}.detalhes`);
    }
    assert.equal(timeline.checks.schedule.detalhes.jobIds.length, 1);
    assert.equal(timeline.checks.compliance.detalhes.policy, 'SO_BAIRRO');
  });
});

test('nao_pula_etapa', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const { itemId } = await service.createContent({ tenant, actor: tenant.userId, input: { type: 'INSTITUTIONAL', title: 'QA-M9 manual', texto: 'Texto institucional.' } }, t);
    await rejectsCode(service.applyTemplate({ tenant, actor: tenant.userId, itemId }, t), 409, 'MKT_PIPELINE_STEP_REQUIRED');
    await rejectsCode(service.requestApprovalIfRequired({ tenant, actor: tenant.userId, itemId }, t), 409, 'MKT_PIPELINE_STEP_REQUIRED');
    await rejectsCode(schedule(t, itemId, { channels: ['SITE'], when: fx.inHours(2).toISOString() }), 409, 'MKT_PIPELINE_STEP_REQUIRED');
    await rejectsCode(approve(t, itemId), 409, 'MKT_CONTENT_INVALID_TRANSITION');
    const row = await fx.loadItem(t, itemId);
    assert.equal(row.status, 'DRAFT');
  });
});

test('retomada_apos_falha_e_idempotente', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const prop = await fx.seedProperty(t, tenant);
    const tpl = await fx.publishedTemplate(t, tenant);
    // texto da NAY com preço errado: a validação reprova e o conteúdo fica em FACT_CHECK_FAILED com os findings
    fx.registerSandboxNay((f) => `Imóvel de ${f.quartos} quartos por R$ 900.000.`);
    const first = await run(t, { type: 'NEW_PROPERTY', sourceEntityType: 'property', sourceEntityId: prop.id, templateId: tpl.id });
    assert.equal(first.content.status, 'FACT_CHECK_FAILED');
    assert.equal(first.content.findings[0].kind, 'PRICE');

    // retomar com a NAY corrigida: nova versão, de volta a DRAFT e adiante até a aprovação
    nay.clearNayDraftProvider();
    fx.registerSandboxNay();
    const resumed = await run(t, { contentItemId: first.content.id, templateId: tpl.id });
    assert.equal(resumed.content.status, 'PENDING_APPROVAL');
    const nVersions = (await versionsOf(t, first.content.id)).length;
    assert.ok(nVersions >= 3, 'versão 1 (reprovada), nova versão corrigida e a versão com a marca');

    // retomar de novo (sem nada novo) não duplica versão nem passo
    const noop = await run(t, { contentItemId: first.content.id, templateId: tpl.id });
    assert.equal(noop.content.status, 'PENDING_APPROVAL');
    assert.equal((await versionsOf(t, first.content.id)).length, nVersions);

    // passo concluído com a mesma entrada devolve o resultado gravado
    const replay = await service.runFactualCheck({ tenant, actor: tenant.userId, itemId: first.content.id }, t);
    assert.equal(replay.replay, true);
    const replayBrand = await service.applyTemplate({ tenant, actor: tenant.userId, itemId: first.content.id, templateId: tpl.id }, t);
    assert.equal(replayBrand.replay, true);
    assert.equal((await versionsOf(t, first.content.id)).length, nVersions);
  });
});

test('nay_indisponivel_nao_trava_redacao_manual', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const prop = await fx.seedProperty(t, tenant);
    // sem provider: indisponível
    const first = await run(t, { type: 'NEW_PROPERTY', sourceEntityType: 'property', sourceEntityId: prop.id });
    assert.equal(first.nayError.code, 'MKT_NAY_UNAVAILABLE');
    assert.equal(first.nayError.statusCode, 503);
    assert.equal(first.content.status, 'DRAFT');
    assert.equal(first.content.currentVersion.body.erro, 'MKT_NAY_UNAVAILABLE');
    // provider que falha também não derruba
    nay.registerNayDraftProvider(async () => { throw new Error('timeout do fornecedor com segredo'); });
    const second = await run(t, { contentItemId: first.content.id });
    assert.equal(second.nayError.code, 'MKT_NAY_UNAVAILABLE');
    assert.doesNotMatch(JSON.stringify(second.nayError.details), /segredo/);
    // redação manual segue o pipeline normalmente
    const manual = await run(t, { contentItemId: first.content.id, texto: 'Casa de 3 quartos por R$ 780.000.' });
    assert.equal(manual.content.status, 'PENDING_APPROVAL');
    assert.equal(manual.content.currentVersion.modelName, null);
    assert.equal(manual.content.currentVersion.nayRunId, null);
  });
});

test('agendamento_respeita_antecedencia_minima', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    fx.registerSandboxNay();
    const { content } = await run(t, { type: 'INSTITUTIONAL', title: 'QA-M9 inst', texto: 'Texto institucional.' });
    await approve(t, content.id);
    const now = new Date('2026-11-10T12:00:00Z');
    const at = (min) => new Date(now.getTime() + min * 60000).toISOString();
    await rejectsCode(schedule(t, content.id, { channels: ['SITE'], when: at(5) }, now), 422, 'MKT_SCHEDULE_TOO_SOON');
    assert.equal((await fx.loadItem(t, content.id)).status, 'APPROVED');
    // o limite é o parâmetro da empresa: com 60 minutos, 30 minutos é cedo demais
    await upsertSetting('marketing.schedule.min_antecedencia_min', 60, tenant, tenant.userId, t);
    await rejectsCode(schedule(t, content.id, { channels: ['SITE'], when: at(30) }, now), 422, 'MKT_SCHEDULE_TOO_SOON');
    const ok = await schedule(t, content.id, { channels: ['SITE'], when: at(60) }, now);
    assert.equal(ok.status, 'SCHEDULED');
  });
});

test('aprovar_sem_validacao_devolve_invalid_transition', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const { itemId } = await service.createContent({ tenant, actor: tenant.userId, input: { type: 'INSTITUTIONAL', title: 'QA-M9 sem validação', texto: 'Texto.' } }, t);
    await assert.rejects(approve(t, itemId), (e) => e.statusCode === 409 && e.code === 'MKT_CONTENT_INVALID_TRANSITION' && /DRAFT -> APPROVED/.test(e.message));
    // quem gerou não aprova
    fx.registerSandboxNay();
    const { content } = await run(t, { type: 'INSTITUTIONAL', title: 'QA-M9 gerado', texto: 'Texto sem números.' });
    await assert.rejects(service.approve({ tenant, actor: tenant.userId, itemId: content.id, input: {} }, t), (e) => e.statusCode === 403 && e.code === 'MKT_FORBIDDEN');
  });
});

test('agendamento_sem_fuso_vale_no_horario_da_empresa', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const instant = await parseWhen('2026-11-10T09:00:00', tenant, t);
    assert.equal(instant.toISOString(), '2026-11-10T12:00:00.000Z'); // America/Sao_Paulo = UTC-3
    assert.equal((await parseWhen('2026-11-10T09:00:00Z', tenant, t)).toISOString(), '2026-11-10T09:00:00.000Z');
    await rejectsCode(parseWhen('amanhã', tenant, t), 400, 'MKT_VALIDATION');
  });
});
