'use strict';

// M9-D405 — Conteúdo guarda fonte, versão da fonte, modelo e run; mudança no imóvel gera atualização e não reescreve o histórico.
// Postgres real, role de runtime (RLS FORCE), transação com rollback. Só em banco descartável (o .env aponta para a homologação remota):
// node scripts/withDisposableDb.js --port <porta> -- ... NODE_ENV=test node --test --test-concurrency=1 test/m9d405.fonteVersaoConteudo.test.js

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize, AuditLog } = require('../src/models');
const { withRollbackTenantTransaction } = require('./testHelpers');
const { prepararTenants } = require('./helpers/marketingExecucao');
const fx = require('./helpers/m9d405Fixtures');
const { createContentWithProvenance, sourceFromProperty } = require('../src/modules/marketing/content/contentProvenance');
const { assertVersionMutable } = require('../src/modules/marketing/content/versionImmutability');
const { processSourceChange } = require('../src/modules/marketing/content/sourceWatcher');
const { archiveSupersededOnPublish } = require('../src/modules/marketing/content/archiveSuperseded');
const { assertSourceFresh } = require('../src/modules/marketing/content/sourceStale');
const { updateProperty } = require('../src/features/properties/properties.service');
const { runEventConsumers, registerEventConsumer } = require('../src/engines/events/consumers');
const { dispatchPendingEventsForCompany } = require('../src/engines/events/outbox-dispatcher');
const { publishDomainEvent } = require('../src/engines/events/outbox');
const { Group, Company } = require('../src/models');
const { withTenantTransaction } = require('./testHelpers');
const { upsertSetting } = require('../src/features/settings/settings.service');
require('../src/modules/marketing/content');

let tenant;
let tenantB;
before(async () => {
  ({ tenantA: tenant, tenantB } = await prepararTenants());
});
after(async () => {
  await sequelize.close();
});

async function seedPublished(t, price = 800000) {
  const prop = await fx.makeProperty(t, tenant);
  const offerId = await fx.makeSaleOffer(t, tenant, prop.id, price);
  const source = await sourceFromProperty(prop.id, tenant, t);
  const { item, version } = await createContentWithProvenance({
    type: 'PRICE_REDUCTION', title: 'QA-M9 Post do apto', source, bodyJson: { texto: `Apto por R$ ${price}` },
  }, tenant, tenant.userId, t);
  await fx.setStatus(t, item.id, 'PUBLISHED');
  return { prop, offerId, item, version };
}

// 1
test('conteudo_guarda_fonte_versao_modelo_e_run', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const prop = await fx.makeProperty(t, tenant);
    await fx.makeSaleOffer(t, tenant, prop.id, 800000);
    const source = await sourceFromProperty(prop.id, tenant, t);
    const runId = fx.uid();
    const nay = await createContentWithProvenance({
      type: 'NEW_PROPERTY', title: 'QA-M9 NAY', source, bodyJson: { texto: 'x' }, generation: { modelName: 'modelo-teste-1', nayRunId: runId },
    }, tenant, tenant.userId, t);
    const row = await fx.loadItem(t, nay.item.id);
    assert.equal(row.source_entity_type, 'property');
    assert.equal(row.source_entity_id, prop.id);
    assert.equal(row.source_version, source.version);
    assert.equal(row.nay_run_id, runId);
    const [v] = await fx.versionsOf(t, nay.item.id);
    assert.equal(v.model_name, 'modelo-teste-1');
    assert.equal(v.nay_run_id, runId);
    assert.equal(v.facts_snapshot_json.precoVenda, 800000);
    assert.match(v.facts_hash, /^[0-9a-f]{64}$/);

    // escrito por humano: modelo e run nulos
    const human = await createContentWithProvenance({ type: 'INSTITUTIONAL', title: 'QA-M9 humano', source, bodyJson: { texto: 'y' } }, tenant, tenant.userId, t);
    const [hv] = await fx.versionsOf(t, human.item.id);
    assert.equal(hv.model_name, null);
    assert.equal(hv.nay_run_id, null);
    assert.equal((await fx.loadItem(t, human.item.id)).nay_run_id, null);

    // gerado sem run: 422 MKT_NAY_RUN_REQUIRED
    await assert.rejects(
      () => createContentWithProvenance({ type: 'NEW_PROPERTY', title: 'QA-M9 sem run', source, bodyJson: {}, generation: { modelName: 'm' } }, tenant, tenant.userId, t),
      (e) => e.statusCode === 422 && e.code === 'MKT_NAY_RUN_REQUIRED' && /execução/.test(e.message)
    );
  });
});

// 2
test('mudanca_no_imovel_nao_reescreve_publicacao_historica', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const { prop, offerId, item, version } = await seedPublished(t);
    const antes = (await fx.versionsOf(t, item.id))[0];
    await fx.changeOfferPrice(t, offerId, 780000);
    await updateProperty(prop.id, { bedrooms: 4 }, tenant.userId, t, tenant);
    await processSourceChange({ entityType: 'property', entityId: prop.id }, tenant, t, tenant.userId);

    const depois = (await fx.versionsOf(t, item.id))[0];
    assert.deepEqual(depois.facts_snapshot_json, antes.facts_snapshot_json);
    assert.deepEqual(depois.body_json, antes.body_json);
    assert.equal(depois.facts_snapshot_json.precoVenda, 800000);
    assert.equal((await fx.loadItem(t, item.id)).status, 'PUBLISHED');

    // versão publicada é imutável no serviço (409) e no banco (MK001)
    await assert.rejects(() => assertVersionMutable(version.id, tenant, t),
      (e) => e.statusCode === 409 && e.code === 'MKT_CONTENT_VERSION_IMMUTABLE' && /não pode ser alterada/.test(e.message));
    await assert.rejects(
      () => fx.q(t, "SAVEPOINT s1; UPDATE marketing.content_versions SET body_json = '{\"x\":1}'::jsonb WHERE id = :id", { id: version.id }),
      /MKT_CONTENT_VERSION_IMMUTABLE|MK001/
    );
  });
});

// 3
test('mudanca_gera_item_de_atualizacao_ligado', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const { prop, offerId, item } = await seedPublished(t);
    await fx.changeOfferPrice(t, offerId, 780000);
    await updateProperty(prop.id, { bedrooms: 4 }, tenant.userId, t, tenant);
    const result = await processSourceChange({ entityType: 'property', entityId: prop.id }, tenant, t, tenant.userId);
    assert.equal(result.updates.length, 1);

    const novo = await fx.loadItem(t, result.updates[0].itemId);
    const antigo = await fx.loadItem(t, item.id);
    assert.equal(novo.type, 'PRICE_REDUCTION');
    assert.equal(novo.status, 'DRAFT');
    assert.equal(novo.updates_content_item_id, item.id);
    assert.equal(antigo.superseded_by, novo.id);
    assert.equal(novo.source_entity_id, prop.id);
    assert.notEqual(novo.source_version, antigo.source_version);
    const [nv] = await fx.versionsOf(t, novo.id);
    assert.equal(nv.facts_snapshot_json.precoVenda, 780000);
    assert.equal(nv.model_name, null);
    assert.equal(novo.current_version_id, nv.id);
    const trilha = await AuditLog.findAll({ where: { entityId: novo.id, action: 'marketing.content.source_update_created' }, transaction: t });
    assert.equal(trilha.length, 1);
    assert.ok(trilha[0].beforeJson && trilha[0].afterJson);
  });
});

// 4
test('conteudo_agendado_com_fonte_velha_volta_para_revisao', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const prop = await fx.makeProperty(t, tenant);
    const offerId = await fx.makeSaleOffer(t, tenant, prop.id, 800000);
    const source = await sourceFromProperty(prop.id, tenant, t);
    const { item, version } = await createContentWithProvenance({ type: 'PRICE_REDUCTION', title: 'QA-M9 agendado', source, bodyJson: { texto: 'x' } }, tenant, tenant.userId, t);
    await fx.setStatus(t, item.id, 'SCHEDULED');
    const jobId = await fx.makeJob(t, tenant, version.id, 'PENDING');
    await assertSourceFresh(item.id, tenant, t); // fresca: não lança

    await fx.changeOfferPrice(t, offerId, 780000);
    await assert.rejects(() => assertSourceFresh(item.id, tenant, t),
      (e) => e.statusCode === 409 && e.code === 'MKT_SOURCE_STALE' && /dados do imóvel mudaram/.test(e.message));
    const result = await processSourceChange({ entityType: 'property', entityId: prop.id }, tenant, t, tenant.userId);

    assert.deepEqual(result.blocked, [item.id]);
    assert.equal((await fx.loadItem(t, item.id)).status, 'FACT_CHECK_FAILED');
    assert.equal((await fx.q(t, 'SELECT status FROM marketing.publication_jobs WHERE id = :id', { id: jobId }))[0].status, 'CANCELLED');
    assert.equal((await fx.versionsOf(t, item.id))[0].checks_json.sourceStale.code, 'MKT_SOURCE_STALE');
    assert.equal(result.updates.length, 0);
  });
});

// 5
test('mesmo_evento_de_imovel_duas_vezes_gera_uma_atualizacao', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const { prop, offerId, item } = await seedPublished(t);
    await fx.changeOfferPrice(t, offerId, 780000);
    await updateProperty(prop.id, { bedrooms: 4 }, tenant.userId, t, tenant);
    const a = await processSourceChange({ entityType: 'property', entityId: prop.id }, tenant, t, tenant.userId);
    const b = await processSourceChange({ entityType: 'property', entityId: prop.id }, tenant, t, tenant.userId);
    assert.equal(a.updates.length, 1);
    assert.equal(b.updates.length, 0);
    const filhos = (await fx.itemsOfSource(t, prop.id)).filter((i) => i.updates_content_item_id === item.id);
    assert.equal(filhos.length, 1);
  });
});

// 6
test('atualizacao_publicada_arquiva_o_item_antigo', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const { prop, offerId, item } = await seedPublished(t);
    await fx.changeOfferPrice(t, offerId, 780000);
    await updateProperty(prop.id, { bedrooms: 4 }, tenant.userId, t, tenant);
    const { updates } = await processSourceChange({ entityType: 'property', entityId: prop.id }, tenant, t, tenant.userId);
    const novoId = updates[0].itemId;

    assert.equal((await archiveSupersededOnPublish(novoId, tenant, tenant.userId, t)).archived, false); // atualização ainda DRAFT
    assert.equal((await fx.loadItem(t, item.id)).status, 'PUBLISHED');

    await fx.setStatus(t, novoId, 'PUBLISHED');
    const r = await archiveSupersededOnPublish(novoId, tenant, tenant.userId, t);
    assert.equal(r.archived, true);
    const antigo = await fx.loadItem(t, item.id);
    assert.equal(antigo.status, 'ARCHIVED');
    assert.equal(antigo.superseded_by, novoId);
    assert.equal((await fx.loadItem(t, novoId)).updates_content_item_id, item.id);
    assert.equal((await archiveSupersededOnPublish(novoId, tenant, tenant.userId, t)).archived, false); // idempotente
  });
});

// 7
test('evento_property_updated_do_outbox_e_isolamento_entre_empresas', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const { prop, offerId, item } = await seedPublished(t);
    await fx.changeOfferPrice(t, offerId, 780000);
    await updateProperty(prop.id, { bedrooms: 4 }, tenant.userId, t, tenant);
    const event = { eventType: 'property.updated', aggregateType: 'Property', aggregateId: prop.id, groupId: tenant.groupId, companyId: tenant.companyId };
    const ran = await runEventConsumers(event, t);
    assert.ok(ran.includes('marketing.content.source_watcher'));
    assert.equal((await fx.itemsOfSource(t, prop.id)).filter((i) => i.updates_content_item_id === item.id).length, 1);

    // a outra empresa, com o mesmo evento, não enxerga nem altera nada
    const other = await withRollbackTenantTransaction(tenantB, (tb) => processSourceChange({ entityType: 'property', entityId: prop.id }, tenantB, tb, tenant.userId));
    assert.deepEqual(other, { updates: [], blocked: [], skipped: [] });
  });
});

// 8
test('dispatcher_do_outbox_chama_os_consumidores_registrados', async () => {
  const seen = [];
  registerEventConsumer('qa.m9d405.evento', 'qa.m9d405.espiao', async (event) => { seen.push(event.aggregateId); });
  const aggregateId = fx.uid();
  await withTenantTransaction(tenant, (t) => publishDomainEvent({
    groupId: tenant.groupId, companyId: tenant.companyId, aggregateType: 'QaM9D405', aggregateId, eventType: 'qa.m9d405.evento',
    payload: {}, idempotencyKey: `qa.m9d405.evento:${aggregateId}`,
  }, t));
  const group = await Group.findByPk(tenant.groupId);
  const company = await sequelize.transaction(async (transaction) => {
    await sequelize.query('SET LOCAL app.group_id = :g', { replacements: { g: tenant.groupId }, transaction });
    return Company.findByPk(tenant.companyId, { transaction });
  });
  await dispatchPendingEventsForCompany(group, company, { limit: 500 });
  assert.ok(seen.includes(aggregateId));
});

// 9
test('parametro_desliga_a_criacao_automatica_da_atualizacao_mas_nao_o_bloqueio', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    await upsertSetting('marketing.conteudo.atualizacao_automatica_fonte', false, tenant, tenant.userId, t);
    const { prop, offerId, item } = await seedPublished(t);
    const agendado = await createContentWithProvenance({
      type: 'PRICE_REDUCTION', title: 'QA-M9 agendado', source: await sourceFromProperty(prop.id, tenant, t), bodyJson: {},
    }, tenant, tenant.userId, t);
    await fx.setStatus(t, agendado.item.id, 'APPROVED');
    await fx.changeOfferPrice(t, offerId, 780000);
    const r = await processSourceChange({ entityType: 'property', entityId: prop.id }, tenant, t, tenant.userId);
    assert.equal(r.updates.length, 0);
    assert.deepEqual(r.skipped, [{ itemId: item.id, reason: 'ATUALIZACAO_AUTOMATICA_DESLIGADA' }]);
    assert.deepEqual(r.blocked, [agendado.item.id]);
    assert.equal((await fx.loadItem(t, item.id)).superseded_by, null);
  });
});
