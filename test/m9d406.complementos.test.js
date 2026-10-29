'use strict';

// M9-D406 — compliance que redige, aprovação por classe (porta da M9-D408), validador plugável (M9-D407), isolamento entre empresas,
// corpo da rota e rejeição. Só em banco descartável (veja m9d406.pipeline.test.js).

const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { sequelize } = require('../src/models');
const { withRollbackTenantTransaction } = require('./testHelpers');
const { prepararTenants } = require('./helpers/marketingExecucao');
const fx = require('./helpers/m9d406Fixtures');
const service = require('../src/features/marketing/content/content.service');
const factual = require('../src/features/marketing/content/pipeline.factualPort');
const policy = require('../src/features/marketing/content/pipeline.approvalPolicy');
const { parseCreateBody, parseScheduleBody } = require('../src/features/marketing/content/content.input');

let tenant;
let tenantB;
let reviewer;
before(async () => {
  ({ tenantA: tenant, tenantB } = await prepararTenants());
  await withRollbackTenantTransaction(tenant, async (t) => {
    reviewer = (await fx.q(t, 'SELECT id FROM core.users WHERE id <> :me AND deleted_at IS NULL ORDER BY id LIMIT 1', { me: tenant.userId }))[0].id;
  });
});
after(async () => { await sequelize.close(); });
afterEach(() => { factual.resetFactualValidator(); policy.resetApprovalPolicy(); });

const run = (t, input) => service.createAndRun({ tenant, actor: tenant.userId, input }, fx.sameTx(t));

test('compliance_redige_dado_pessoal_em_nova_versao_e_registra_o_que_removeu', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const { content } = await run(t, { type: 'INSTITUTIONAL', title: 'QA-M9 contato', texto: 'Fale com a Ana pelo e-mail ana@exemplo.com.br.' }); // número solto (CPF, telefone) já é barrado antes, pelo validador factual (M9-D407)
    assert.equal(content.status, 'PENDING_APPROVAL');
    assert.doesNotMatch(content.currentVersion.body.texto, /ana@exemplo/);
    assert.match(content.currentVersion.body.texto, /\[REDIGIDO\]/);
    assert.deepEqual(content.checks.compliance.detalhes.redactedPatterns, ['EMAIL']);
    const versions = await fx.versionsOf(t, content.id);
    assert.equal(versions.length, 2, 'a versão original é imutável; a limpa é a próxima versão');
    assert.match(versions[0].body_json.texto, /ana@exemplo/);
    assert.equal(content.currentVersion.versionNo, 2);
  });
});

test('autopublicacao_so_por_classe_registrada_e_marca_approved_by_do_sistema', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const humano = await run(t, { type: 'SOLD_RENTED', title: 'QA-M9 sem classe', texto: 'Vendido.' });
    assert.equal(humano.content.status, 'PENDING_APPROVAL');
    policy.registerApprovalPolicy(async () => ({ autopublish: true, classId: 'SOLD_RENTED+SITE', channels: ['SITE'] }));
    const auto = await run(t, { type: 'SOLD_RENTED', title: 'QA-M9 com classe', texto: 'Vendido.' });
    assert.equal(auto.content.status, 'APPROVED');
    assert.equal(auto.content.currentVersion.approvedBy, 'SYSTEM_AUTOPUBLISH:SOLD_RENTED+SITE');
    assert.match(auto.content.currentVersion.approvedHash, /^[0-9a-f]{64}$/);
    // e o agendamento aceita (aprovação íntegra)
    const out = await service.schedule({ tenant, actor: reviewer, itemId: auto.content.id, channels: ['SITE'], when: fx.inHours(1).toISOString() }, t);
    assert.equal(out.status, 'SCHEDULED');
  });
});

test('validador_factual_plugavel_e_base_bloqueia_preco_e_quartos_divergentes', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const facts = { precoVenda: 780000, quartos: 3 };
    assert.equal(factual.validateAgainstFacts('Casa de 3 quartos por R$ 780.000', facts).ok, true);
    assert.equal(factual.validateAgainstFacts('Casa por R$ 780k, três quartos', facts).ok, true);
    const bad = factual.validateAgainstFacts('Casa de 4 quartos por R$ 800.000', facts);
    assert.deepEqual(bad.findings.map((f) => f.kind).sort(), ['PRICE', 'ROOMS']);
    // a M9-D407 registra o validador completo; o pipeline passa a usá-lo
    factual.registerFactualValidator(() => ({ ok: false, findings: [{ kind: 'UNKNOWN_CLAIM', claim: 'x', expected: null, found: 'x', severity: 'BLOCK' }] }));
    const out = await run(t, { type: 'INSTITUTIONAL', title: 'QA-M9 plugável', texto: 'Texto.' });
    assert.equal(out.content.status, 'FACT_CHECK_FAILED');
    assert.equal(out.content.findings[0].kind, 'UNKNOWN_CLAIM');
  });
});

test('rejeitar_exige_motivo_e_devolve_a_rascunho', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const { content } = await run(t, { type: 'INSTITUTIONAL', title: 'QA-M9 rejeição', texto: 'Texto.' });
    const reject = (reason) => service.approve({ tenant, actor: reviewer, itemId: content.id, input: { decision: 'REJECT', reason } }, t);
    await assert.rejects(reject('curto'), (e) => e.statusCode === 400 && e.code === 'MKT_REASON_REQUIRED');
    assert.equal((await reject('O texto precisa citar a metragem.')).status, 'DRAFT');
    await assert.rejects(service.approve({ tenant, actor: reviewer, itemId: content.id, input: { decision: 'TALVEZ' } }, t), (e) => e.code === 'MKT_VALIDATION');
  });
});

test('conteudo_de_outra_empresa_nao_aparece_nem_aprova', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const { content } = await run(t, { type: 'INSTITUTIONAL', title: 'QA-M9 RLS', texto: 'Texto.' });
    await withRollbackTenantTransaction(tenantB, async (tb) => {
      await assert.rejects(service.getContent(tenantB, content.id, tb), (e) => e.statusCode === 404 && e.code === 'MKT_NOT_FOUND');
      await assert.rejects(service.approve({ tenant: tenantB, actor: reviewer, itemId: content.id, input: {} }, tb), (e) => e.statusCode === 404);
    });
  });
});

test('corpo_das_rotas_recusa_campo_desconhecido_e_dado_invalido', () => {
  const bad = (fn, body) => assert.throws(() => fn(body), (e) => e.statusCode === 400 && e.code === 'MKT_VALIDATION');
  bad(parseCreateBody, { type: 'NEW_PROPERTY', sourceEntityType: 'property', sourceEntityId: fx.uid(), status: 'APPROVED' });
  bad(parseCreateBody, { type: 'INVENTADO', title: 'x' });
  bad(parseCreateBody, { type: 'NEW_PROPERTY', sourceEntityType: 'property' });
  bad(parseCreateBody, { type: 'INSTITUTIONAL', title: 'x', texto: '   ' });
  bad(parseScheduleBody, { channels: ['SITE'], when: 'x', jobs: [] });
  assert.equal(parseCreateBody({ type: 'INSTITUTIONAL', title: 'ok' }).type, 'INSTITUTIONAL');
});

test('agendar_com_canal_invalido_ou_vazio_e_400_e_fonte_desatualizada_e_409', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const prop = await fx.seedProperty(t, tenant);
    fx.registerSandboxNay();
    const { content } = await run(t, { type: 'NEW_PROPERTY', sourceEntityType: 'property', sourceEntityId: prop.id });
    await service.approve({ tenant, actor: reviewer, itemId: content.id, input: {} }, t);
    const when = fx.inHours(2).toISOString();
    for (const channels of [[], ['TELEGRAM'], undefined]) {
      await assert.rejects(service.schedule({ tenant, actor: reviewer, itemId: content.id, channels, when }, t), (e) => e.statusCode === 400 && e.code === 'MKT_VALIDATION');
    }
    // o imóvel mudou depois da geração: agendar é recusado (M9-D405)
    await fx.q(t, "UPDATE real_estate.property_offers SET asking_price = 900000 WHERE property_id = :p", { p: prop.id });
    await assert.rejects(service.schedule({ tenant, actor: reviewer, itemId: content.id, channels: ['SITE'], when }, t), (e) => e.statusCode === 409 && e.code === 'MKT_SOURCE_STALE');
  });
});
