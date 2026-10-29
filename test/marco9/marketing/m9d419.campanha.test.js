'use strict';

// M9-D419 — opt-out no meio da campanha: as etapas seguintes ficam canceladas só para quem saiu (BLOCKED/SUPPRESSED), os demais
// continuam recebendo. Banco descartável (ver m9d418.campanha.test.js); rollback.

const { test, before, afterEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { sequelize } = require('../../../src/models');
const { withRollbackTenantTransaction } = require('../../testHelpers');
const campaigns = require('../../../src/features/marketing/campaigns/campaigns.service');
const lifecycle = require('../../../src/features/marketing/campaigns/lifecycle.service');
const { registerCampaignSendPort, clearCampaignSendPort } = require('../../../src/features/marketing/campaigns/sendPort');
const { buildCampaignSendPort, automatic } = require('../../../src/features/marketing/suppression');
const env = require('../_helpers/mktOptOut');

const { readyPerson, makeTemplate, completeBody, q } = env;
let A;
before(async () => { ({ a: A } = await env.tenants()); });
afterEach(() => clearCampaignSendPort());
after(async () => { await sequelize.close(); });
const DAY_MIN = 1440;
const START = '2031-12-01T09:00:00';
const tick = (n) => new Date(Date.parse('2031-12-01T12:00:10Z') + n * 3 * 24 * 3600 * 1000); // 09:00:10 em São Paulo, a cada 3 dias

test('opt_out_cancela_steps_posteriores', async () => {
  await withRollbackTenantTransaction(A, async (t) => {
    const carlos = await readyPerson(t, A);
    const ana = await readyPerson(t, A);
    const sentTo = [];
    registerCampaignSendPort(buildCampaignSendPort({ send: async (ctx) => { sentTo.push(`${ctx.personId}:${ctx.stepNo}`); return { ok: true, externalRef: `m-${sentTo.length}` }; } }));
    const templateId = await makeTemplate(t, A);
    const body = completeBody({
      templateId, personIds: [carlos, ana], startsAt: START, endsAt: '2031-12-20T18:00:00',
      audiences: [{ kind: 'PERSON_LIST', purpose: 'MARKETING', filter: { personIds: [carlos, ana] } }],
      steps: [0, 1, 2, 3].map((n) => ({ channel: 'EMAIL', templateId, offsetMinutes: n * 3 * DAY_MIN })),
    });
    const { campaign } = await campaigns.saveCampaign(A, A.userId, { ...body, schedule: true }, { permissions: ['marketing:campaign:manage'] }, t);
    const deliveries = () => q(t, `SELECT d.person_id, s.step_no, d.status, d.reason FROM marketing.campaign_step_deliveries d
      JOIN marketing.campaign_steps s ON s.id = d.step_id WHERE d.campaign_id = :c ORDER BY s.step_no, d.person_id`, { c: campaign.id });
    const of = (rows, person) => rows.filter((r) => r.person_id === person).map((r) => `${r.step_no}:${r.status}${r.reason ? `/${r.reason}` : ''}`);

    await lifecycle.runLifecycleTick(A, t, tick(0)); // etapa 1
    await lifecycle.runLifecycleTick(A, t, tick(1)); // etapa 2
    assert.deepEqual(of(await deliveries(), carlos), ['1:SENT', '2:SENT']);

    // Carlos sai na etapa 2 de 4 (resposta SAIR)
    const out = await automatic.handleInboundReply({ personId: carlos, channel: 'EMAIL', text: 'SAIR' }, A, t);
    assert.equal(out.suppressed, true);

    await lifecycle.runLifecycleTick(A, t, tick(2)); // etapa 3
    await lifecycle.runLifecycleTick(A, t, tick(3)); // etapa 4
    const rows = await deliveries();
    assert.deepEqual(of(rows, carlos), ['1:SENT', '2:SENT', '3:BLOCKED/SUPPRESSED', '4:BLOCKED/SUPPRESSED'], 'etapas 3 e 4 canceladas para Carlos');
    assert.deepEqual(of(rows, ana), ['1:SENT', '2:SENT', '3:SENT', '4:SENT'], 'quem não saiu segue recebendo');
    assert.ok(!sentTo.some((s) => s.startsWith(`${carlos}:3`) || s.startsWith(`${carlos}:4`)), 'o adapter nunca foi chamado para Carlos depois do opt-out');
  });
});
