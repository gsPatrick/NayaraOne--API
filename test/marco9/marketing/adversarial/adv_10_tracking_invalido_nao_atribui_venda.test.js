'use strict';

// M9-D437 adv_10 (Caderno §16: "Tracking inválido -> não atribui venda"). Clique com short_code adulterado, link com destino ou assinatura trocados, revogado e inexistente: 404 no clique,
// nenhum attribution_event de clique, e a venda posterior da pessoa fica NAO_ATRIBUIDA sem campanha. Cenário da dona (M9-D431), sem lógica própria. Banco descartável.
const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { sequelize } = require('../../../../src/models');
const { withRollbackTenantTransaction } = require('../../../testHelpers');
const { prepararTenants } = require('../../../helpers/marketingExecucao');
const fx = require('../../_helpers/m9d431Fixtures');
const adv = require('../../_helpers/mktAdv');
const tracking = require('../../../../src/features/marketing/tracking').service;

let tenant;
let cleanup;
before(async () => { ({ tenantA: tenant } = await prepararTenants()); cleanup = fx.useTempSecretStore(); });
after(async () => { cleanup(); await sequelize.close(); });
afterEach(() => tracking.resetExternalUrlValidator());

const link = (t, over = {}) => tracking.createTrackingLink({ tenant, actor: tenant.userId, input: { targetUrl: 'https://nayara.com.br/imovel/1234', channel: 'EMAIL', ...over } }, t);
const click = (t, shortCode, extra = {}) => tracking.resolveClick({ shortCode, session: { ip: '203.0.113.9', userAgent: 'QA-M9' }, transaction: t, ...extra });
const rejects404 = (promise) => assert.rejects(promise, (e) => e.statusCode === 404 && e.code === 'MKT_TRACKING_LINK_NOT_FOUND');

test('adv_10_tracking_invalido_nao_atribui_venda: short_code adulterado, assinatura trocada e link revogado; a venda posterior não é atribuída', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const camp = await fx.makeCampaign(t, tenant);
    const lk = await link(t, { campaignId: camp.id });
    const personId = await fx.makePerson(t, tenant);
    const opportunityId = await fx.makeOpportunity(t, tenant, personId);
    await fx.optIn(t, tenant, personId, 'EMAIL');
    const messageId = await fx.makeMessage(t, tenant, personId, 'EMAIL');
    const token = await tracking.createMessageToken(tenant, lk.id, messageId);
    // (1) o código adulterado (um caractere trocado), o inexistente e o malformado dão 404, mesmo com o token r válido da mensagem
    const adulterado = `${lk.shortCode.slice(0, 7)}${lk.shortCode[7] === '2' ? '3' : '2'}`;
    await rejects404(click(t, adulterado, { token }));
    await rejects404(click(t, 'ZZZZZZZZ', { token }));
    await rejects404(click(t, 'a b'));
    // a assinatura trocada e o destino alterado no banco invalidam o link
    const outra = await link(t, { campaignId: camp.id });
    const [o] = await fx.q(t, 'SELECT signature FROM marketing.tracking_links WHERE id = :id', { id: outra.id });
    await fx.q(t, 'UPDATE marketing.tracking_links SET signature = :s WHERE id = :id RETURNING id', { s: o.signature, id: lk.id });
    await rejects404(click(t, lk.shortCode, { token }));
    await fx.q(t, "UPDATE marketing.tracking_links SET target_url = 'https://malicioso.example/golpe' WHERE id = :id RETURNING id", { id: outra.id });
    await rejects404(click(t, outra.shortCode, { token }));
    const revogado = await link(t, { campaignId: camp.id });
    await fx.q(t, "UPDATE marketing.tracking_links SET status = 'REVOKED' WHERE id = :id RETURNING id", { id: revogado.id });
    await rejects404(click(t, revogado.shortCode));
    // (2) zero eventos para a campanha e a venda posterior fica NAO_ATRIBUIDA, sem campanha
    assert.equal((await fx.events(t, 'campaign_id = :c', { c: camp.id })).length, 0, 'zero attribution_events para a campanha');
    assert.equal((await fx.events(t)).length, 0, 'nenhum evento de clique foi gravado');
    const sold = await tracking.recordSale({ tenant, actor: tenant.userId, opportunityId, contractId: fx.uid(), contractValue: 500000, occurredAt: new Date('2026-11-20T10:00:00Z') }, t);
    assert.equal(sold.attributed, false);
    const [sale] = await fx.events(t, "event_type = 'SALE'");
    assert.equal(sale.evidence_json.attribution, 'NAO_ATRIBUIDA');
    assert.equal(sale.campaign_id, null);
    assert.equal((await fx.events(t, 'campaign_id = :c', { c: camp.id })).length, 0, 'a campanha continua sem evento');
    const report = await tracking.attributionReport(tenant, {}, t);
    assert.deepEqual(report.unattributed, { sales: 1, value: 500000 });
    assert.ok(report.campaigns.every((c) => c.models.first.sales === 0 && c.models.last.sales === 0));
    // isolamento (RLS): a outra empresa não enxerga o evento da venda
    await adv.assertIsolated(t, tenant, [{ tabela: 'marketing.attribution_events', ids: [sale.id] }]);
  });
});
