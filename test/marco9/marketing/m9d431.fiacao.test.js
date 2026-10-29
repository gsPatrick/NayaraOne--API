'use strict';

// M9-D431 (reabertura) — fiação real: o redirecionamento decide pela supressão (D419 regra 4), a venda entra pelo consumidor
// de contract.activated e a origem do lead entra pelo createOpportunity do CRM. Só em banco descartável:
// node scripts/withDisposableDb.js --port <porta> -- ... NODE_ENV=test node --test --test-concurrency=1 test/marco9/marketing/m9d431.fiacao.test.js

const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { sequelize } = require('../../../src/models');
const { withRollbackTenantTransaction } = require('../../testHelpers');
const { prepararTenants } = require('../../helpers/marketingExecucao');
const fx = require('../_helpers/m9d431Fixtures');
const env = require('../_helpers/mktPolicyEnv');
const tracking = require('../../../src/features/marketing/tracking').service;
const sup = require('../../../src/features/marketing/suppression');
const { runEventConsumers } = require('../../../src/engines/events/consumers');
const { createOpportunity } = require('../../../src/features/crm/opportunity.service');

let tenant;
let cleanup;
before(async () => { ({ tenantA: tenant } = await prepararTenants()); cleanup = fx.useTempSecretStore(); });
after(async () => { cleanup(); await sequelize.close(); });
afterEach(() => tracking.resetExternalUrlValidator());

const link = (t, over = {}) => tracking.createTrackingLink({ tenant, actor: tenant.userId, input: { targetUrl: 'https://nayara.com.br/imovel/1234', channel: 'EMAIL', ...over } }, t);
const click = async (t, lk, messageId, now) => tracking.resolveClick({
  shortCode: lk.shortCode, token: await tracking.createMessageToken(tenant, lk.id, messageId), session: { ip: '203.0.113.9', userAgent: 'QA-M9' }, transaction: t, now: new Date(now),
});
const lastClick = async (t) => (await fx.events(t, "event_type = 'CLICK'")).slice(-1)[0];

test('clique_de_pessoa_suprimida_com_opt_in_e_anonimo: o redirecionamento decide por mayIdentify', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const camp = await fx.makeCampaign(t, tenant);
    const lk = await link(t, { campaignId: camp.id });
    const mk = async () => { const p = await env.readyPerson(t, tenant, { phone: null }); return { p, m: await fx.makeMessage(t, tenant, p, 'EMAIL') }; };
    const ok = await mk();
    const bounced = await mk();
    const complained = await mk();
    await sup.service.suppress({ personId: bounced.p, channel: 'EMAIL', reason: 'BOUNCE', source: 'QA-M9' }, tenant, t);
    await sup.service.suppress({ personId: complained.p, channel: 'EMAIL', reason: 'COMPLAINT', source: 'QA-M9' }, tenant, t);
    assert.deepEqual(await sup.trackingConsent.mayIdentify(bounced.p, 'EMAIL', tenant, t), { identify: false, reason: 'SUPPRESSED' });
    await click(t, lk, ok.m, '2026-11-02T10:00:00Z');
    assert.equal((await lastClick(t)).person_id, ok.p, 'sem supressão e com OPT_IN: identificado');
    for (const [i, who] of [bounced, complained].entries()) {
      await click(t, lk, who.m, `2026-11-02T10:0${i + 1}:00Z`);
      const event = await lastClick(t);
      assert.equal(event.person_id, null);
      assert.equal(event.evidence_json.identified, false);
      assert.deepEqual(event.touch_roles, []);
    }
  });
});

test('contract_activated_registra_venda_pelo_consumidor: só contrato de venda com oportunidade', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const camp = await fx.makeCampaign(t, tenant);
    const lk = await link(t, { campaignId: camp.id });
    const personId = await fx.makePerson(t, tenant);
    await fx.optIn(t, tenant, personId, 'EMAIL');
    const opportunityId = await fx.makeOpportunity(t, tenant, personId);
    await click(t, lk, await fx.makeMessage(t, tenant, personId, 'EMAIL'), new Date(Date.now() - 5 * fx.DAY).toISOString());
    const contract = (type, opp, value) => fx.q(t, `INSERT INTO legal.contracts (id, group_id, company_id, opportunity_id, contract_type, status, total_value, lock_version)
      VALUES (gen_random_uuid(), :g, :c, :o, :ty, 'ACTIVE', :v, 0) RETURNING id`, { g: tenant.groupId, c: tenant.companyId, o: opp, ty: type, v: value }).then((r) => r[0].id);
    const fire = (contractId) => runEventConsumers({ eventType: 'contract.activated', aggregateId: contractId, groupId: tenant.groupId, companyId: tenant.companyId }, t);
    const lease = await contract('LEASE', opportunityId, '2500.00');
    assert.ok((await fire(lease)).includes('marketing.tracking.sale_attribution'));
    assert.equal((await fx.events(t, "event_type = 'SALE'")).length, 0, 'locação não é venda');
    const noOpp = await contract('SALE', null, '1000.00');
    await fire(noOpp);
    assert.equal((await fx.events(t, "event_type = 'SALE'")).length, 0, 'sem oportunidade não há venda');
    const sold = await contract('SALE', opportunityId, '780000.50');
    await fire(sold);
    await fire(sold); // idempotente
    const [sale] = await fx.events(t, "event_type = 'SALE'");
    assert.equal((await fx.events(t, "event_type = 'SALE'")).length, 1);
    assert.equal(sale.opportunity_id, opportunityId);
    assert.equal(sale.evidence_json.contractId, sold);
    assert.equal(Number(sale.evidence_json.contractValue), 780000.5);
    assert.equal(sale.campaign_id, camp.id, 'toque na janela: a campanha recebe a venda');
  });
});

test('create_opportunity_com_lead_source_grava_origem_e_evento', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const camp = await fx.makeCampaign(t, tenant);
    const lk = await link(t, { campaignId: camp.id });
    const base = { groupId: tenant.groupId, companyId: tenant.companyId, stage: 'NEW', nextAction: 'Ligar', nextActionDueAt: new Date(Date.now() + fx.DAY).toISOString() };
    const personId = await fx.makePerson(t, tenant);
    const good = await createOpportunity({ ...base, personId, leadSource: 'form', campaignId: camp.id, trackingLinkId: lk.id }, tenant.userId, t);
    const [row] = await fx.q(t, 'SELECT lead_source, campaign_id, tracking_link_id, attribution_valid FROM crm.opportunities WHERE id = :id', { id: good.id });
    assert.deepEqual([row.lead_source, row.campaign_id, row.tracking_link_id, row.attribution_valid], ['FORM', camp.id, lk.id, true]);
    const [event] = await fx.events(t, "event_type = 'LEAD_CREATED'");
    assert.equal(event.opportunity_id, good.id);
    assert.equal(event.campaign_id, camp.id);
    // referência inválida: lead nasce normal, sem atribuição
    const bad = await createOpportunity({ ...base, personId: await fx.makePerson(t, tenant), leadSource: 'FORM', campaignId: fx.uid(), trackingLinkId: fx.uid() }, tenant.userId, t);
    const [badRow] = await fx.q(t, 'SELECT lead_source, campaign_id, tracking_link_id, attribution_valid FROM crm.opportunities WHERE id = :id', { id: bad.id });
    assert.deepEqual([badRow.lead_source, badRow.campaign_id, badRow.tracking_link_id, badRow.attribution_valid], ['FORM', null, null, false]);
    // sem leadSource: nada é gravado
    await createOpportunity({ ...base, personId: await fx.makePerson(t, tenant) }, tenant.userId, t);
    assert.equal((await fx.events(t, "event_type = 'LEAD_CREATED'")).length, 2);
  });
});
