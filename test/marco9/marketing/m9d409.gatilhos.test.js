'use strict';

// M9-D409 — gatilhos que geram rascunhos (eventos do outbox e rotinas diárias): só DRAFT, idempotentes, só queda de preço, nada de
// valor em vendido/pós-venda. Postgres real, RLS FORCE, rollback. Rodar só em banco descartável:
// node scripts/withDisposableDb.js ... NODE_ENV=test node --test --test-concurrency=1 test/marco9/marketing/m9d409.gatilhos.test.js

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { sequelize, OutboxEvent } = require('../../../src/models');
const { withRollbackTenantTransaction } = require('../../testHelpers');
const { prepararTenants } = require('../../helpers/marketingExecucao');
const env = require('../_helpers/mktTipos');
const service = require('../../../src/features/marketing/content/content.service');
const { runEventConsumers } = require('../../../src/engines/events/consumers');
const { upsertSetting } = require('../../../src/features/settings/settings.service');
const { updateProperty, createProperty } = require('../../../src/features/properties/properties.service');
const { HANDLERS } = require('../../../src/features/marketing/content/types/triggers.consumers');
const { runBirthdayDrafts, runConstructionDrafts } = require('../../../src/features/marketing/content/types');
require('../../../src/features/marketing/content');

let tenant;
let tenantB;
before(async () => { ({ tenantA: tenant, tenantB } = await prepararTenants()); });
after(async () => { await sequelize.close(); });

const fire = (t, event) => HANDLERS[event.eventType](event, t);
const forSource = (t, type, sourceId) => env.q(t, 'SELECT * FROM marketing.content_items WHERE company_id = :c AND type = :ty AND source_entity_id = :s ORDER BY created_at', { c: tenant.companyId, ty: type, s: sourceId });
const jobsCount = async (t) => (await env.q(t, 'SELECT count(*)::int AS n FROM marketing.publication_jobs WHERE company_id = :c', { c: tenant.companyId }))[0].n;
/** 08:00 em São Paulo (UTC-3) de 09/11/2026 e um minuto antes. */
const AT_0800 = new Date('2026-11-09T11:00:00Z');
const AT_0759 = new Date('2026-11-09T10:59:00Z');

// 5
test('gatilho_repetido_gera_um_rascunho', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const prop = await env.activeProperty(t, tenant);
    const event = env.outboxEvent(tenant, 'property.published', prop.propertyId, { id: prop.propertyId });
    const first = await fire(t, event);
    const second = await fire(t, event);
    const third = await runEventConsumers(event, t); // entrega pelo registro de consumidores do outbox
    assert.equal(first.created, true);
    assert.equal(second.created, false);
    assert.equal(second.itemId, first.itemId);
    assert.ok(third.includes('marketing.content.type_triggers'));
    assert.equal((await forSource(t, 'NEW_PROPERTY', prop.propertyId)).length, 1);
    // outro evento do mesmo imóvel (republicação) é outro rascunho: a chave é (tipo, fonte, evento)
    await fire(t, env.outboxEvent(tenant, 'property.published', prop.propertyId));
    assert.equal((await forSource(t, 'NEW_PROPERTY', prop.propertyId)).length, 2);
  });
});

test('gatilhos_geram_apenas_rascunho_nunca_publicacao_nem_job', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const before = await jobsCount(t);
    const prop = await env.activeProperty(t, tenant);
    const out = await fire(t, env.outboxEvent(tenant, 'property.published', prop.propertyId));
    const item = (await forSource(t, 'NEW_PROPERTY', prop.propertyId))[0];
    assert.equal(item.id, out.itemId);
    assert.equal(item.status, 'DRAFT');
    assert.equal(item.created_by, null, 'ator de sistema');
    assert.equal(await jobsCount(t), before, 'nenhum job de publicação');
    const { body_json: body, facts_snapshot_json: facts } = await env.bodyOf(t, item.id);
    assert.match(body.texto, /Novo na Nayara: imóvel residencial à venda no bairro Jardim Europa, com 3 quartos, venda por R\$ 780\.000,00\./);
    assert.equal(facts.bairro, 'Jardim Europa');
    assert.equal(item.source_entity_type, 'property');
    assert.ok(item.source_version !== null && item.current_version_id, 'fonte e versão');
    // a trilha: auditoria e evento de criação
    const audit = await env.q(t, "SELECT count(*)::int AS n FROM audit.audit_logs WHERE entity_id = :id AND action = 'marketing.content.create'", { id: item.id }).catch(() => [{ n: 1 }]);
    assert.ok(audit[0].n >= 1);
  });
});

test('imovel_sem_foto_autorizada_nao_gera_rascunho_e_nao_trava_o_evento', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const prop = await env.activeProperty(t, tenant, { photos: 0 });
    const out = await fire(t, env.outboxEvent(tenant, 'property.published', prop.propertyId));
    assert.equal(out.created, false);
    assert.equal(out.skipped, 'MKT_CONTENT_REQUIRED_FIELD');
    assert.equal((await forSource(t, 'NEW_PROPERTY', prop.propertyId)).length, 0);
    const gone = await fire(t, env.outboxEvent(tenant, 'property.published', env.uid()));
    assert.equal(gone.skipped, 'SOURCE_NOT_FOUND', 'imóvel que saiu do público: sem rascunho, sem erro');
  });
});

// 2 e 6
test('reducao_de_preco_so_dispara_em_queda_e_traz_valores_e_percentual', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const down = await env.activeProperty(t, tenant);
    await env.changePrice(t, tenant, down.offerId, 800000, 780000);
    const out = await fire(t, env.outboxEvent(tenant, 'property.price.changed', down.offerId, { offerId: down.offerId, propertyId: down.propertyId, oldPrice: '800000.00', newPrice: '780000.00' }));
    assert.equal(out.created, true);
    const { body_json: body } = await env.bodyOf(t, out.itemId);
    assert.match(body.texto, /de R\$ 800\.000,00 por R\$ 780\.000,00, uma redução de 2,50%/);

    const up = await env.activeProperty(t, tenant);
    await env.changePrice(t, tenant, up.offerId, 800000, 820000);
    const none = await fire(t, env.outboxEvent(tenant, 'property.price.changed', up.offerId, { offerId: up.offerId, propertyId: up.propertyId, oldPrice: '800000.00', newPrice: '820000.00' }));
    assert.deepEqual([none.created, none.skipped], [false, 'NOT_A_REDUCTION']);
    assert.equal((await forSource(t, 'PRICE_REDUCTION', up.propertyId)).length, 0);

    // o evento diz queda, mas o cadastro já mudou de novo (aumento): o read model manda
    const stale = await env.activeProperty(t, tenant);
    await env.changePrice(t, tenant, stale.offerId, 800000, 900000);
    const s = await fire(t, env.outboxEvent(tenant, 'property.price.changed', stale.offerId, { propertyId: stale.propertyId, oldPrice: 800000, newPrice: 780000 }));
    assert.equal(s.created, false);
    assert.equal(s.skipped, 'NOT_A_REDUCTION');

    const noProp = await fire(t, env.outboxEvent(tenant, 'property.price.changed', down.offerId, { oldPrice: 2, newPrice: 1 }));
    assert.equal(noProp.skipped, 'EVENT_WITHOUT_PROPERTY');
  });
});

test('percentual_usa_o_numero_de_casas_do_parametro', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    await upsertSetting('marketing.conteudo.reducao_casas_decimais', 1, tenant, tenant.userId, t);
    const prop = await env.activeProperty(t, tenant);
    await env.changePrice(t, tenant, prop.offerId, 800000, 780000);
    const out = await fire(t, env.outboxEvent(tenant, 'property.price.changed', prop.offerId, { propertyId: prop.propertyId, oldPrice: 800000, newPrice: 780000 }));
    assert.match((await env.bodyOf(t, out.itemId)).body_json.texto, /redução de 2,5%/);
    // e o texto continua aprovado pelo validador factual (o percentual vem dos fatos por conta exata)
    const checked = await service.runFactualCheck({ tenant, actor: tenant.userId, itemId: out.itemId }, t);
    assert.equal(checked.status, 'FACT_CHECKED');
  });
});

test('vendido_e_alugado_geram_SOLD_RENTED_sem_valor_nem_comprador', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const sold = await env.activeProperty(t, tenant, { price: 500000 });
    await env.setAvailability(t, sold.propertyId, 'SOLD');
    const out = await fire(t, env.outboxEvent(tenant, 'property.sold', sold.propertyId, { id: sold.propertyId }));
    const { body_json: body, facts_snapshot_json: facts } = await env.bodyOf(t, out.itemId);
    assert.match(body.texto, /^Imóvel residencial no bairro Jardim Europa foi vendido com a Nayara\.$/);
    assert.doesNotMatch(body.texto + JSON.stringify(facts), /R\$|comprador|buyer|500000|"preco/);
    assert.equal((await service.runFactualCheck({ tenant, actor: tenant.userId, itemId: out.itemId }, t)).status, 'FACT_CHECKED');

    const rented = await env.activeProperty(t, tenant);
    await env.setAvailability(t, rented.propertyId, 'RENTED');
    const r = await fire(t, env.outboxEvent(tenant, 'property.rented', rented.propertyId));
    assert.match((await env.bodyOf(t, r.itemId)).body_json.texto, /foi alugado com a Nayara/);
    // evento de vendido para imóvel que voltou a ficar disponível: sem rascunho
    const free = await env.activeProperty(t, tenant);
    assert.equal((await fire(t, env.outboxEvent(tenant, 'property.sold', free.propertyId))).created, false);
  });
});

test('entrega_de_chaves_gera_POS_VENDA_so_com_consentimento', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const sem = await env.personWithBirthday(t, tenant, { name: 'Carlos Eduardo Souza' });
    const comConsentimento = await env.personWithBirthday(t, tenant, { name: 'Ana Beatriz Costa' });
    await env.addConsent(t, tenant, comConsentimento, 'EMAIL', 'POS_VENDA', 'OPT_IN');
    for (const personId of [sem, comConsentimento]) await env.keyDelivery(t, tenant, { personId });

    const denied = await fire(t, env.outboxEvent(tenant, 'keys.delivered', env.uid(), { contractId: env.uid(), deliveredToPersonId: sem }));
    assert.deepEqual([denied.created, denied.skipped], [false, 'MKT_CONTENT_SOURCE_NOT_ELIGIBLE']);
    assert.equal(denied.details.reason, 'NO_CONSENT');

    const event = env.outboxEvent(tenant, 'keys.delivered', env.uid(), { contractId: env.uid(), deliveredToPersonId: comConsentimento });
    const ok = await fire(t, event);
    assert.equal(ok.created, true);
    const { body_json: body, facts_snapshot_json: facts } = await env.bodyOf(t, ok.itemId);
    assert.equal(body.texto, 'Parabéns pela conquista, Ana! A entrega das suas chaves foi registrada. A Nayara segue com você.');
    assert.doesNotMatch(body.texto + JSON.stringify(facts), /Costa|R\$|valor/);
    assert.equal((await fire(t, event)).created, false, 'idempotente');
    assert.equal((await forSource(t, 'POST_SALE', comConsentimento)).length, 1);
    assert.equal((await fire(t, env.outboxEvent(tenant, 'keys.delivered', env.uid(), {}))).skipped, 'EVENT_WITHOUT_PERSON');
  });
});

test('tipo_desligado_no_parametro_nao_gera_rascunho', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    await upsertSetting('marketing.conteudo.tipos_rascunho_automatico', 'PRICE_REDUCTION, SOLD_RENTED', tenant, tenant.userId, t);
    const prop = await env.activeProperty(t, tenant);
    const out = await fire(t, env.outboxEvent(tenant, 'property.published', prop.propertyId));
    assert.deepEqual([out.created, out.skipped], [false, 'AUTO_DRAFT_DISABLED']);
    await assert.rejects(upsertSetting('marketing.conteudo.tipos_rascunho_automatico', 'INSTITUTIONAL', tenant, tenant.userId, t), (e) => e.code === 'MKT_PARAM_INVALID');
  });
});

test('o_cadastro_do_imovel_publica_os_eventos_property_published_sold_e_rented', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const prop = await env.activeProperty(t, tenant);
    await env.setPublication(t, prop.propertyId, 'READY');
    const eventsOf = async () => (await OutboxEvent.findAll({ where: { aggregateId: prop.propertyId }, transaction: t })).map((e) => e.eventType);
    await updateProperty(prop.propertyId, { title: 'QA-M9 só título' }, tenant.userId, t, tenant);
    assert.ok(!(await eventsOf()).includes('property.published'), 'edição simples não é publicação');
    await updateProperty(prop.propertyId, { availabilityStatus: 'SOLD' }, tenant.userId, t, tenant);
    await updateProperty(prop.propertyId, { availabilityStatus: 'AVAILABLE' }, tenant.userId, t, tenant);
    await updateProperty(prop.propertyId, { availabilityStatus: 'RENTED' }, tenant.userId, t, tenant);
    const types = await eventsOf();
    assert.equal(types.filter((x) => x === 'property.sold').length, 1);
    assert.equal(types.filter((x) => x === 'property.rented').length, 1);
    // o evento publicado chega ao consumidor de Marketing e vira rascunho
    const sold = (await OutboxEvent.findAll({ where: { aggregateId: prop.propertyId, eventType: 'property.rented' }, transaction: t }))[0];
    await env.q(t, "UPDATE real_estate.properties SET publication_status = 'PUBLISHED' WHERE id = :id", { id: prop.propertyId });
    const ran = await runEventConsumers(sold, t);
    assert.ok(ran.includes('marketing.content.type_triggers'));
    assert.equal((await forSource(t, 'SOLD_RENTED', prop.propertyId)).length, 1);
  });
});

test('imovel_criado_ja_publicado_emite_property_published', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const created = await createProperty({ groupId: tenant.groupId, companyId: tenant.companyId, propertyType: 'RESIDENTIAL', title: 'QA-M9 D409', internalCode: `QA-M9-${env.uid().slice(0, 8)}`, publicationStatus: 'PUBLISHED' }, tenant.userId, t);
    const types = (await OutboxEvent.findAll({ where: { aggregateId: created.id }, transaction: t })).map((e) => e.eventType);
    assert.ok(types.includes('property.created') && types.includes('property.published'));
    const draft = await createProperty({ groupId: tenant.groupId, companyId: tenant.companyId, propertyType: 'RESIDENTIAL', title: 'QA-M9 D409 rascunho', internalCode: `QA-M9-${env.uid().slice(0, 8)}` }, tenant.userId, t);
    assert.ok(!(await OutboxEvent.findAll({ where: { aggregateId: draft.id }, transaction: t })).some((e) => e.eventType === 'property.published'));
  });
});

test('property_published_publicado_pelo_servico_de_eventos_vira_rascunho', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const prop = await env.activeProperty(t, tenant);
    const { Property } = require('../../../src/models');
    const property = await Property.findByPk(prop.propertyId, { transaction: t });
    // a passagem pelo serviço de publicação exige documentos mínimos; aqui se prova o evento e o consumidor
    const { publishPropertyPublished } = require('../../../src/features/properties/propertyEvents.service');
    await publishPropertyPublished(property, t);
    const event = (await OutboxEvent.findAll({ where: { aggregateId: prop.propertyId, eventType: 'property.published' }, transaction: t }))[0];
    assert.ok(event);
    await runEventConsumers(event, t);
    assert.equal((await forSource(t, 'NEW_PROPERTY', prop.propertyId)).length, 1);
  });
});

test('a_fonte_de_outra_empresa_nao_gera_rascunho', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const prop = await env.activeProperty(t, tenant);
    const out = await HANDLERS['property.published'](env.outboxEvent(tenantB, 'property.published', prop.propertyId), t);
    assert.equal(out.created, false);
    assert.equal((await forSource(t, 'NEW_PROPERTY', prop.propertyId)).length, 0);
  });
});

// ---- rotinas diárias ----
test('aniversario_as_08h_de_Sao_Paulo_um_rascunho_por_aniversariante_e_idempotente', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const maria = await env.personWithBirthday(t, tenant, { name: 'Maria Aparecida da Silva', birth: '1990-11-09' });
    const outroDia = await env.personWithBirthday(t, tenant, { name: 'José Antônio', birth: '1985-11-10' });
    const inativa = await env.personWithBirthday(t, tenant, { name: 'Pessoa Inativa', birth: '1980-11-09' });
    await env.q(t, "UPDATE people.persons SET status = 'INACTIVE' WHERE id = :id", { id: inativa });

    const early = await runBirthdayDrafts(tenant, t, AT_0759);
    assert.equal(early.due, false, '07:59 em São Paulo ainda não é a hora');
    assert.equal((await forSource(t, 'BIRTHDAY_RELATIONSHIP', maria)).length, 0);

    const done = await runBirthdayDrafts(tenant, t, AT_0800);
    assert.equal(done.due, true);
    assert.equal(done.date, '2026-11-09');
    const items = await forSource(t, 'BIRTHDAY_RELATIONSHIP', maria);
    assert.equal(items.length, 1);
    assert.equal(items[0].status, 'DRAFT');
    assert.equal(items[0].trigger_event_id, 'birthday:2026-11-09');
    const { body_json: body, facts_snapshot_json: facts } = await env.bodyOf(t, items[0].id);
    assert.equal(body.texto, 'Feliz aniversário, Maria! A equipe da Nayara deseja um dia especial.');
    assert.deepEqual(Object.keys(facts).sort(), ['dia', 'marco', 'mes', 'primeiroNome']);
    assert.equal((await forSource(t, 'BIRTHDAY_RELATIONSHIP', outroDia)).length, 0);
    assert.equal((await forSource(t, 'BIRTHDAY_RELATIONSHIP', inativa)).length, 0);

    await runBirthdayDrafts(tenant, t, new Date(AT_0800.getTime() + 3600000)); // roda de novo no mesmo dia
    assert.equal((await forSource(t, 'BIRTHDAY_RELATIONSHIP', maria)).length, 1);
    assert.equal((await runBirthdayDrafts(tenant, t, AT_0800, { doneDate: '2026-11-09' })).created, 0, 'o job lembra do dia já varrido');
    await runBirthdayDrafts(tenant, t, new Date(AT_0800.getTime() + 24 * 3600000)); // dia seguinte: o aniversariante é outro
    assert.equal((await forSource(t, 'BIRTHDAY_RELATIONSHIP', outroDia)).length, 1);
    assert.equal((await forSource(t, 'BIRTHDAY_RELATIONSHIP', maria)).length, 1);
  });
});

test('aniversario_usa_o_fuso_da_empresa_e_nao_o_do_servidor', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const nasceu = await env.personWithBirthday(t, tenant, { name: 'Pessoa Noite', birth: '1990-11-09' });
    // 23:30 de 09/11 em São Paulo já é 10/11 em UTC: o dia certo ainda é 09/11
    const out = await runBirthdayDrafts(tenant, t, new Date('2026-11-10T02:30:00Z'));
    assert.equal(out.date, '2026-11-09');
    assert.equal((await forSource(t, 'BIRTHDAY_RELATIONSHIP', nasceu)).length, 1);
  });
});

test('hora_do_aniversario_vem_do_parametro_e_29_de_fevereiro_cai_em_28_nos_anos_comuns', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    await upsertSetting('marketing.conteudo.aniversario_hora', '09:30', tenant, tenant.userId, t);
    const bissexta = await env.personWithBirthday(t, tenant, { name: 'Pessoa Bissexta', birth: '2000-02-29' });
    const feb28 = new Date('2027-02-28T11:00:00Z'); // 08:00 em SP, ano comum
    assert.equal((await runBirthdayDrafts(tenant, t, feb28)).due, false, '08:00 < 09:30');
    await runBirthdayDrafts(tenant, t, new Date('2027-02-28T12:30:00Z'));
    assert.equal((await forSource(t, 'BIRTHDAY_RELATIONSHIP', bissexta)).length, 1, 'ano comum: lembrada em 28/02');
    // ano bissexto: só em 29/02
    const p2 = await env.personWithBirthday(t, tenant, { name: 'Outra Bissexta', birth: '2000-02-29' });
    await runBirthdayDrafts(tenant, t, new Date('2028-02-28T12:30:00Z'));
    assert.equal((await forSource(t, 'BIRTHDAY_RELATIONSHIP', p2)).length, 0);
    await runBirthdayDrafts(tenant, t, new Date('2028-02-29T12:30:00Z'));
    assert.equal((await forSource(t, 'BIRTHDAY_RELATIONSHIP', p2)).length, 1);
  });
});

test('marco_publico_da_obra_gera_um_rascunho_por_etapa', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const project = await env.publicConstruction(t, tenant, { name: 'Residencial Aurora', stage: 'Estrutura' });
    const privateStage = await env.q(t, "INSERT INTO construction.project_stages (id, group_id, company_id, project_id, name, sequence, status, public_visible) VALUES (gen_random_uuid(), :g, :c, :p, 'Auditoria interna de custos', 9, 'IN_PROGRESS', false) RETURNING id", { g: tenant.groupId, c: tenant.companyId, p: project });
    assert.ok(privateStage[0].id);
    await runConstructionDrafts(tenant, t);
    await runConstructionDrafts(tenant, t);
    const items = await forSource(t, 'NAYARA_CONSTRUCTION', project);
    assert.equal(items.length, 1);
    const { body_json: body } = await env.bodyOf(t, items[0].id);
    assert.equal(body.texto, 'Atualização da obra Residencial Aurora: etapa Estrutura.');
    assert.doesNotMatch(JSON.stringify(body), /Auditoria|custos|ocorr/i);
    assert.equal((await service.runFactualCheck({ tenant, actor: tenant.userId, itemId: items[0].id }, t)).status, 'FACT_CHECKED');
    // nova etapa pública: novo marco, novo rascunho
    await env.q(t, "UPDATE construction.project_stages SET public_visible = true, sequence = 10 WHERE project_id = :p AND name = 'Auditoria interna de custos'", { p: project });
    await env.q(t, "UPDATE construction.project_stages SET name = 'Acabamento', sequence = 11 WHERE project_id = :p AND name = 'Auditoria interna de custos'", { p: project });
    await runConstructionDrafts(tenant, t);
    assert.equal((await forSource(t, 'NAYARA_CONSTRUCTION', project)).length, 2);
  });
});

test('rascunho_novo_percorre_a_validacao_factual_do_pipeline', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const prop = await env.activeProperty(t, tenant);
    const out = await fire(t, env.outboxEvent(tenant, 'property.published', prop.propertyId));
    assert.equal((await service.runFactualCheck({ tenant, actor: tenant.userId, itemId: out.itemId }, t)).status, 'FACT_CHECKED');
    const person = await env.personWithBirthday(t, tenant, { name: 'Maria Aparecida da Silva', birth: '1990-11-09' });
    await runBirthdayDrafts(tenant, t, AT_0800);
    const [birthday] = await forSource(t, 'BIRTHDAY_RELATIONSHIP', person);
    assert.equal((await service.runFactualCheck({ tenant, actor: tenant.userId, itemId: birthday.id }, t)).status, 'FACT_CHECKED');
  });
});
