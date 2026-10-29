'use strict';

// M9-D431 — atribuição (MKT-012): links assinados, clique com consentimento e token r, first-touch/last-touch, janela, venda sem evidência.
// Postgres real, role de runtime (RLS FORCE), transação com rollback, cofre de arquivos temporário. Só em banco descartável:
// node scripts/withDisposableDb.js --port <porta> -- ... NODE_ENV=test node --test --test-concurrency=1 test/marco9/marketing/m9d431.atribuicao.test.js

const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { sequelize } = require('../../../src/models');
const { withRollbackTenantTransaction } = require('../../testHelpers');
const { prepararTenants } = require('../../helpers/marketingExecucao');
const fx = require('../_helpers/m9d431Fixtures');
const tracking = require('../../../src/features/marketing/tracking').service;
const { upsertSetting } = require('../../../src/features/settings/settings.service');

let tenant;
let cleanup;
before(async () => { ({ tenantA: tenant } = await prepararTenants()); cleanup = fx.useTempSecretStore(); });
after(async () => { cleanup(); await sequelize.close(); });
afterEach(() => tracking.resetExternalUrlValidator());

const URL_OK = 'https://nayara.com.br/imovel/1234';
const link = (t, over = {}, who = tenant) => tracking.createTrackingLink({ tenant: who, actor: tenant.userId, input: { targetUrl: URL_OK, channel: 'EMAIL', ...over } }, t);
const click = (t, shortCode, extra = {}) => tracking.resolveClick({ shortCode, session: { ip: '203.0.113.9', userAgent: 'QA-M9' }, transaction: t, ...extra });
const at = (iso) => new Date(iso);
const rejects404 = (promise) => assert.rejects(promise, (e) => e.statusCode === 404 && e.code === 'MKT_TRACKING_LINK_NOT_FOUND');

/** Pessoa com consentimento, oportunidade, mensagem e o token r do link. */
async function lead(t, { consent = true, channel = 'EMAIL' } = {}) {
  const personId = await fx.makePerson(t, tenant);
  const opportunityId = await fx.makeOpportunity(t, tenant, personId);
  if (consent) await fx.optIn(t, tenant, personId, channel);
  const messageId = await fx.makeMessage(t, tenant, personId, channel);
  return { personId, opportunityId, messageId };
}
const tokenFor = (l, lk, messageId) => tracking.createMessageToken(tenant, lk.id, messageId);
const touch = async (t, lk, who, when) => click(t, lk.shortCode, { token: await tokenFor(who, lk, who.messageId), now: at(when) });
const sale = (t, who, when, value = 1000, contractId = fx.uid()) => tracking.recordSale({ tenant, actor: tenant.userId, opportunityId: who.opportunityId, contractId, contractValue: value, occurredAt: at(when) }, t);
const newLead = (t, who, when, extra = {}) => tracking.recordLeadSource({ tenant, actor: tenant.userId, opportunityId: who.opportunityId, leadSource: 'FORM', now: at(when), ...extra }, t);

test('first_touch_e_last_touch_armazenados: dois cliques identificados, lead e venda', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const camp = await fx.makeCampaign(t, tenant);
    const a = await link(t, { channel: 'INSTAGRAM', campaignId: camp.id, utmSource: 'instagram' });
    const b = await link(t, { channel: 'EMAIL', campaignId: camp.id });
    const ana = await lead(t, { channel: 'WHATSAPP' });
    await fx.optIn(t, tenant, ana.personId, 'EMAIL');
    const msgEmail = await fx.makeMessage(t, tenant, ana.personId, 'EMAIL');
    const clickA = await click(t, a.shortCode, { token: await tracking.createMessageToken(tenant, a.id, ana.messageId), now: at('2026-11-02T10:00:00Z') });
    assert.match(clickA.location, /^https:\/\/nayara\.com\.br\/imovel\/1234\?utm_source=instagram&utm_medium=social&utm_campaign=/);
    await click(t, b.shortCode, { token: await tracking.createMessageToken(tenant, b.id, msgEmail), now: at('2026-11-10T09:00:00Z') });
    const lead1 = await newLead(t, ana, '2026-11-11T09:00:00Z');
    assert.equal(lead1.event.event_type, 'LEAD_CREATED');
    const sold = await sale(t, ana, '2026-12-20T15:00:00Z', 780000);
    assert.equal(sold.attributed, true);
    const clicks = await fx.events(t, "event_type = 'CLICK'");
    assert.equal(clicks.length, 2);
    assert.deepEqual(clicks[0].touch_roles, ['FIRST']);
    assert.deepEqual(clicks[1].touch_roles, ['LAST']);
    assert.equal(clicks[0].tracking_link_id, a.id);
    assert.equal(clicks[1].tracking_link_id, b.id);
    const [saleEvent] = await fx.events(t, "event_type = 'SALE'");
    assert.equal(saleEvent.evidence_json.firstTouchEventId, clicks[0].id);
    assert.equal(saleEvent.evidence_json.lastTouchEventId, clicks[1].id);
    assert.equal(saleEvent.evidence_json.contractValue, 780000);
    // nenhum outro papel nem modelo: só FIRST e LAST existem
    assert.ok((await fx.events(t)).every((e) => e.touch_roles.every((r) => ['FIRST', 'LAST'].includes(r))));
    await fx.q(t, 'SAVEPOINT s1');
    await assert.rejects(fx.q(t, "UPDATE marketing.attribution_events SET touch_roles = '{LINEAR}' WHERE id = :id RETURNING id", { id: clicks[0].id }), /touch_roles_chk/);
    await fx.q(t, 'ROLLBACK TO SAVEPOINT s1');
    // a venda é única por oportunidade: repetir é replay
    assert.equal((await sale(t, ana, '2026-12-20T15:00:00Z', 780000)).replay, true);
    assert.equal((await fx.events(t, "event_type = 'SALE'")).length, 1);
  });
});

test('um_so_toque_guarda_first_e_last_no_mesmo_evento', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const camp = await fx.makeCampaign(t, tenant);
    const lk = await link(t, { campaignId: camp.id });
    const who = await lead(t);
    await touch(t, lk, who, '2026-11-03T10:00:00Z');
    await newLead(t, who, '2026-11-04T10:00:00Z');
    await sale(t, who, '2026-11-20T10:00:00Z');
    const [only] = await fx.events(t, "event_type = 'CLICK'");
    assert.deepEqual([...only.touch_roles].sort(), ['FIRST', 'LAST']);
  });
});

test('tracking_invalido_nao_atribui_venda: link adulterado, expirado ou inexistente não grava nada', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const camp = await fx.makeCampaign(t, tenant);
    const lk = await link(t, { campaignId: camp.id });
    const who = await lead(t);
    await fx.q(t, "UPDATE marketing.tracking_links SET target_url = 'https://malicioso.example/golpe' WHERE id = :id RETURNING id", { id: lk.id });
    await rejects404(click(t, lk.shortCode, { token: await tokenFor(who, lk, who.messageId), now: at('2026-11-02T10:00:00Z') }));
    await rejects404(click(t, 'ZZZZZZZZ'));
    await rejects404(click(t, 'a b'));
    assert.equal((await fx.events(t)).length, 0);
    const sold = await sale(t, who, '2026-11-20T10:00:00Z');
    assert.equal(sold.attributed, false);
    const [event] = await fx.events(t, "event_type = 'SALE'");
    assert.equal(event.evidence_json.attribution, 'NAO_ATRIBUIDA');
    assert.equal(event.campaign_id, null);
    // link revogado e link expirado: 404
    const revoked = await link(t, { campaignId: camp.id });
    await fx.q(t, "UPDATE marketing.tracking_links SET status = 'REVOKED' WHERE id = :id RETURNING id", { id: revoked.id });
    await rejects404(click(t, revoked.shortCode));
    const expiring = await link(t, { campaignId: camp.id, expiresAt: new Date(Date.now() + 3600000).toISOString() });
    await rejects404(click(t, expiring.shortCode, { now: new Date(Date.now() + 2 * 3600000) }));
    assert.equal((await fx.events(t, "event_type = 'CLICK'")).length, 0);
  });
});

test('assinatura_do_link_adulterada_404: trocar a assinatura ou o código invalida o link', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const lk = await link(t, {});
    assert.match(lk.shortCode, /^[2-9A-HJKMNP-Z]{8}$/);
    assert.equal(lk.path, `/t/${lk.shortCode}`);
    const [row] = await fx.q(t, 'SELECT signature FROM marketing.tracking_links WHERE id = :id', { id: lk.id });
    assert.match(row.signature, /^[0-9a-f]{64}$/);
    await click(t, lk.shortCode); // íntegro: 302
    await fx.q(t, "UPDATE marketing.tracking_links SET signature = :s WHERE id = :id RETURNING id", { s: 'a'.repeat(64), id: lk.id });
    await rejects404(click(t, lk.shortCode));
    // a assinatura de OUTRO link não vale neste
    const other = await link(t, {});
    const [o] = await fx.q(t, 'SELECT signature FROM marketing.tracking_links WHERE id = :id', { id: other.id });
    await fx.q(t, 'UPDATE marketing.tracking_links SET signature = :s WHERE id = :id RETURNING id', { s: o.signature, id: lk.id });
    await rejects404(click(t, lk.shortCode));
  });
});

test('clique_identificado_so_com_token_r_valido_e_consentimento', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const camp = await fx.makeCampaign(t, tenant);
    const lk = await link(t, { campaignId: camp.id });
    const other = await link(t, { campaignId: camp.id });
    const ok = await lead(t);
    const noConsent = await lead(t, { consent: false });
    const goodToken = await tokenFor(ok, lk, ok.messageId);
    const cases = [
      ['r_valido_com_consentimento', goodToken, true],
      ['sem_r', undefined, false],
      ['r_adulterado', goodToken.slice(0, -4) + (goodToken.endsWith('0000') ? '1111' : '0000'), false],
      ['r_de_outro_link', await tokenFor(ok, other, ok.messageId), false],
      ['r_lixo', 'v1.nao-e-token', false],
      ['r_valido_sem_consentimento', await tokenFor(noConsent, lk, noConsent.messageId), false],
      ['r_de_mensagem_inexistente', await tracking.createMessageToken(tenant, lk.id, fx.uid()), false],
    ];
    let minute = 0;
    for (const [name, token, identified] of cases) {
      minute += 1;
      await click(t, lk.shortCode, { token, now: at(`2026-11-02T10:0${minute}:00Z`) });
      const [event] = await fx.events(t, "event_type = 'CLICK'", {}).then((rows) => rows.slice(-1));
      assert.equal(event.person_id !== null, identified, name);
      assert.equal(event.evidence_json.identified, identified, name);
      if (!identified) assert.equal(event.evidence_json.messageId, undefined, name);
    }
    // OPT_OUT depois do OPT_IN também deixa o clique anônimo
    await fx.q(t, 'SELECT 1');
    await require('../../../src/features/people/personConsents.service').recordConsent(ok.personId, { channel: 'EMAIL', purpose: 'MARKETING', status: 'OPT_OUT' }, tenant.userId, t);
    await click(t, lk.shortCode, { token: goodToken, now: at('2026-11-02T11:00:00Z') });
    assert.equal((await fx.events(t, "event_type = 'CLICK'")).slice(-1)[0].person_id, null);
  });
});

test('clique_sem_consentimento_sem_pessoa: clique anônimo só conta e nunca é toque', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const camp = await fx.makeCampaign(t, tenant);
    const lk = await link(t, { campaignId: camp.id });
    const who = await lead(t, { consent: false });
    await click(t, lk.shortCode, { token: await tokenFor(who, lk, who.messageId), now: at('2026-11-02T10:00:00Z') });
    const [event] = await fx.events(t, "event_type = 'CLICK'");
    assert.equal(event.person_id, null);
    await newLead(t, who, '2026-11-03T10:00:00Z');
    const sold = await sale(t, who, '2026-11-20T10:00:00Z');
    assert.equal(sold.attributed, false, 'clique anônimo nunca é toque');
    assert.deepEqual((await fx.events(t, "event_type = 'CLICK'"))[0].touch_roles, []);
    // um CLICK por link, sessão e minuto: repetir no mesmo minuto não duplica; outro minuto grava
    await click(t, lk.shortCode, { now: at('2026-11-02T10:00:30Z') });
    await click(t, lk.shortCode, { now: at('2026-11-02T10:00:50Z') });
    assert.equal((await fx.events(t, "event_type = 'CLICK'")).length, 1);
    await click(t, lk.shortCode, { now: at('2026-11-02T10:01:10Z') });
    assert.equal((await fx.events(t, "event_type = 'CLICK'")).length, 2);
    await tracking.resolveClick({ shortCode: lk.shortCode, session: { ip: '198.51.100.7', userAgent: 'outra sessão' }, transaction: t, now: at('2026-11-02T10:01:20Z') });
    assert.equal((await fx.events(t, "event_type = 'CLICK'")).length, 3);
  });
});

test('janela_de_90_dias_respeitada: o parâmetro da empresa define a janela', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const camp = await fx.makeCampaign(t, tenant);
    const lk = await link(t, { campaignId: camp.id });
    const day = (n) => new Date(Date.parse('2027-03-01T12:00:00Z') - n * fx.DAY).toISOString();
    const far = await lead(t); const near = await lead(t);
    await touch(t, lk, far, day(120));
    await touch(t, lk, near, day(80));
    assert.equal((await sale(t, far, day(0))).attributed, false);
    assert.equal((await sale(t, near, day(0))).attributed, true);
    // com a janela de 365 dias o toque de 120 dias vale; com 30 o de 80 não vale
    await upsertSetting('marketing.attribution.janela_dias', 365, tenant, tenant.userId, t);
    const far2 = await lead(t); await touch(t, lk, far2, day(120));
    assert.equal((await sale(t, far2, day(0))).attributed, true);
    await upsertSetting('marketing.attribution.janela_dias', 30, tenant, tenant.userId, t);
    const near2 = await lead(t); await touch(t, lk, near2, day(80));
    assert.equal((await sale(t, near2, day(0))).attributed, false);
    await assert.rejects(upsertSetting('marketing.attribution.janela_dias', 0, tenant, tenant.userId, t));
  });
});

test('venda_sem_evidencia_nao_atribuida: sem toque não vai para a campanha ativa e evento sem evidência é recusado', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    await fx.makeCampaign(t, tenant); // campanha existente: não pode receber a venda por suposição
    const who = await lead(t);
    const out = await sale(t, who, '2026-11-20T10:00:00Z', 500000);
    assert.equal(out.attributed, false);
    const report = await tracking.attributionReport(tenant, {}, t);
    assert.deepEqual(report.unattributed, { sales: 1, value: 500000 });
    assert.ok(report.campaigns.every((c) => c.models.first.sales === 0 && c.models.last.sales === 0));
    // evidência obrigatória por tipo
    const base = { tenant, actor: tenant.userId, personId: who.personId };
    for (const [eventType, evidence] of [['CLICK', {}], ['CLICK', { shortCode: 'X' }], ['LEAD_CREATED', null], ['VISIT', {}], ['PROPOSAL', { x: 1 }], ['SALE', { contractId: fx.uid() }]]) {
      await assert.rejects(tracking.recordEvent({ ...base, eventType, evidence }, t), (e) => e.statusCode === 422 && e.code === 'MKT_ATTRIBUTION_EVIDENCE_REQUIRED', `${eventType} ${JSON.stringify(evidence)}`);
    }
    await assert.rejects(tracking.recordSale({ tenant, actor: tenant.userId, opportunityId: who.opportunityId, contractId: null, contractValue: 10 }, t), (e) => e.code === 'MKT_ATTRIBUTION_EVIDENCE_REQUIRED');
    await assert.rejects(tracking.recordSale({ tenant, actor: tenant.userId, opportunityId: who.opportunityId, contractId: fx.uid(), contractValue: 'abc' }, t), (e) => e.code === 'MKT_ATTRIBUTION_EVIDENCE_REQUIRED');
  });
});
