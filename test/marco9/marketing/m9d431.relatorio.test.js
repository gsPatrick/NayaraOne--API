'use strict';

// M9-D431 — relatório por campanha (valor = soma de contractValue), modelo não suportado, origem do lead e isolamento entre empresas.
// Só em banco descartável: node scripts/withDisposableDb.js --port <porta> -- ... NODE_ENV=test node --test test/marco9/marketing/m9d431.relatorio.test.js

const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { sequelize } = require('../../../src/models');
const { withRollbackTenantTransaction } = require('../../testHelpers');
const { prepararTenants } = require('../../helpers/marketingExecucao');
const fx = require('../_helpers/m9d431Fixtures');
const tracking = require('../../../src/features/marketing/tracking').service;

let tenant;
let tenantB;
let cleanup;
before(async () => { ({ tenantA: tenant, tenantB } = await prepararTenants()); cleanup = fx.useTempSecretStore(); });
after(async () => { cleanup(); await sequelize.close(); });
afterEach(() => tracking.resetExternalUrlValidator());

const at = (iso) => new Date(iso);
const link = (t, over = {}, who = tenant) => tracking.createTrackingLink({ tenant: who, actor: tenant.userId, input: { targetUrl: 'https://nayara.com.br/imovel/1', channel: 'EMAIL', ...over } }, t);

async function lead(t, channel = 'EMAIL') {
  const personId = await fx.makePerson(t, tenant);
  const opportunityId = await fx.makeOpportunity(t, tenant, personId);
  await fx.optIn(t, tenant, personId, channel);
  return { personId, opportunityId, messageId: await fx.makeMessage(t, tenant, personId, channel) };
}
const touch = async (t, lk, who, when) => tracking.resolveClick({
  shortCode: lk.shortCode, token: await tracking.createMessageToken(tenant, lk.id, who.messageId), session: { ip: '203.0.113.9', userAgent: 'QA-M9' }, transaction: t, now: at(when),
});
const newLead = (t, who, when, extra = {}) => tracking.recordLeadSource({ tenant, actor: tenant.userId, opportunityId: who.opportunityId, leadSource: 'FORM', now: at(when), ...extra }, t);
const sale = (t, who, when, value) => tracking.recordSale({ tenant, actor: tenant.userId, opportunityId: who.opportunityId, contractId: fx.uid(), contractValue: value, occurredAt: at(when) }, t);

/** Duas pessoas, campanhas distintas: Ana (A primeiro, B por último) e Bia (só B). */
async function cenario(t) {
  const campA = await fx.makeCampaign(t, tenant); const campB = await fx.makeCampaign(t, tenant);
  const linkA = await link(t, { channel: 'INSTAGRAM', campaignId: campA.id }); const linkB = await link(t, { channel: 'EMAIL', campaignId: campB.id });
  const ana = await lead(t); const bia = await lead(t);
  await touch(t, linkA, ana, '2026-11-02T10:00:00Z'); await touch(t, linkB, ana, '2026-11-10T10:00:00Z');
  await newLead(t, ana, '2026-11-11T10:00:00Z'); await sale(t, ana, '2026-12-20T10:00:00Z', 780000.5);
  await touch(t, linkB, bia, '2026-11-12T10:00:00Z'); await newLead(t, bia, '2026-11-13T10:00:00Z'); await sale(t, bia, '2026-12-21T10:00:00Z', 120000.25);
  return { campA, campB };
}
const byId = (report, id) => report.campaigns.find((c) => c.campaignId === id);

test('relatorio_por_campanha_agregado: contagens e valores por campanha e canal, sem pessoas', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const { campA, campB } = await cenario(t);
    const all = await tracking.attributionReport(tenant, {}, t);
    assert.deepEqual(all.models, ['first', 'last']);
    const a = byId(all, campA.id); const b = byId(all, campB.id);
    assert.equal(a.clicks, 1); assert.equal(b.clicks, 2); assert.equal(b.identifiedClicks, 2);
    assert.deepEqual(a.models, { first: { sales: 1, value: 780000.5 }, last: { sales: 0, value: 0 } });
    assert.deepEqual(b.models, { first: { sales: 1, value: 120000.25 }, last: { sales: 2, value: 900000.75 } });
    assert.deepEqual(a.channels.map((c) => c.channel), ['INSTAGRAM']);
    assert.ok(!JSON.stringify(all).includes('personId') && !JSON.stringify(all).includes('person_id'), 'o relatório não expõe pessoas');
    const one = await tracking.attributionReport(tenant, { campaignId: campB.id, model: 'last' }, t);
    assert.deepEqual(one.models, ['last']);
    assert.equal(one.campaigns.length, 1);
    assert.deepEqual(one.campaigns[0].models, { last: { sales: 2, value: 900000.75 } });
    const ranged = await tracking.attributionReport(tenant, { from: '2026-12-21T00:00:00Z', to: '2026-12-31T00:00:00Z' }, t);
    assert.equal(ranged.campaigns.reduce((s, c) => s + c.models.last.sales, 0), 1);
  });
});

test('valor_da_campanha_soma_contract_value_dos_eventos_sale: soma exata em BRL com duas casas', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const camp = await fx.makeCampaign(t, tenant);
    const lk = await link(t, { campaignId: camp.id });
    const values = [0.1, 0.2, 1234.56, 99999.99];
    for (const [i, v] of values.entries()) {
      const who = await lead(t);
      await touch(t, lk, who, `2026-11-0${i + 1}T10:00:00Z`);
      await newLead(t, who, `2026-11-0${i + 1}T11:00:00Z`);
      await sale(t, who, '2026-12-01T10:00:00Z', v);
    }
    const report = await tracking.attributionReport(tenant, { campaignId: camp.id }, t);
    assert.equal(report.campaigns[0].models.first.value, 101234.85);
    assert.equal(report.campaigns[0].models.last.value, 101234.85);
    assert.equal(report.campaigns[0].models.last.sales, 4);
  });
});

test('modelo_nao_suportado: 400 MKT_ATTRIBUTION_MODEL_UNSUPPORTED', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    for (const model of ['linear', 'time_decay', 'u_shaped']) {
      await assert.rejects(tracking.attributionReport(tenant, { model }, t), (e) => e.statusCode === 400 && e.code === 'MKT_ATTRIBUTION_MODEL_UNSUPPORTED', model);
    }
  });
});

test('lead_com_referencia_invalida_nasce_sem_atribuicao e campanha_ou_link_de_outra_empresa_sem_atribuicao', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const camp = await fx.makeCampaign(t, tenant);
    const lk = await link(t, { campaignId: camp.id });
    const ok = await lead(t);
    const good = await newLead(t, ok, '2026-11-05T10:00:00Z', { trackingLinkId: lk.id, campaignId: camp.id });
    assert.equal(good.attributionValid, true);
    const [opp] = await fx.q(t, 'SELECT lead_source, campaign_id, tracking_link_id, attribution_valid FROM crm.opportunities WHERE id = :id', { id: ok.opportunityId });
    assert.deepEqual(opp, { lead_source: 'FORM', campaign_id: camp.id, tracking_link_id: lk.id, attribution_valid: true });

    // link e campanha reais, mas de OUTRA empresa (a RLS os esconde da empresa A)
    const setCompany = async (who) => {
      await sequelize.query('SET LOCAL app.group_id = :g', { replacements: { g: who.groupId }, transaction: t });
      await sequelize.query('SET LOCAL app.company_id = :c', { replacements: { c: who.companyId }, transaction: t });
    };
    await setCompany(tenantB);
    const campB = await fx.makeCampaign(t, tenantB);
    const linkB = await link(t, { campaignId: campB.id }, tenantB);
    await setCompany(tenant);

    for (const [name, ref] of [['link_de_outra_empresa', { trackingLinkId: linkB.id }], ['campanha_de_outra_empresa', { campaignId: campB.id }], ['link_inexistente', { trackingLinkId: fx.uid() }]]) {
      const who = await lead(t);
      const out = await newLead(t, who, '2026-11-06T10:00:00Z', ref);
      assert.equal(out.attributionValid, false, name);
      const [row] = await fx.q(t, 'SELECT campaign_id, tracking_link_id, attribution_valid FROM crm.opportunities WHERE id = :id', { id: who.opportunityId });
      assert.deepEqual(row, { campaign_id: null, tracking_link_id: null, attribution_valid: false }, name);
      assert.equal(out.event.event_type, 'LEAD_CREATED', `${name}: o lead é criado normalmente`);
    }
    // o link de outra empresa nem redireciona nem registra na empresa A
    const [{ n }] = await fx.q(t, "SELECT count(*)::int AS n FROM marketing.attribution_events WHERE campaign_id = :c", { c: campB.id });
    assert.equal(n, 0);
  });
});
