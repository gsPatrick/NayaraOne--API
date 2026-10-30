'use strict';

// M9-D437 adv_14 (Caderno §16: "Campanha encerrada -> steps não continuam"). Campanha com um step já enviado, um SCHEDULED e um job PENDING: ao encerrar, o step vira CANCELLED
// (CAMPAIGN_ENDED), o job CANCELLED, o runner responde BLOCKED CAMPAIGN_NOT_RUNNING e, mesmo forçando o step de volta a SCHEDULED, nada é enviado. Cenário da dona (M9-D412). Banco descartável.
const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { sequelize } = require('../../../../src/models');
const { withRollbackTenantTransaction } = require('../../../testHelpers');
const campaigns = require('../../../../src/features/marketing/campaigns/campaigns.service');
const lifecycle = require('../../../../src/features/marketing/campaigns/lifecycle.service');
const { assertCampaignRunning } = require('../../../../src/features/marketing/campaigns/runnerGuard');
const { registerCampaignSendPort, clearCampaignSendPort } = require('../../../../src/features/marketing/campaigns/sendPort');
const { insertContent, insertJob } = require('../../../helpers/m9d404Fixtures');
const { tenants, makePerson, makeTemplate, completeBody, loadSteps, q } = require('../../../helpers/m9d412Fixtures');
const adv = require('../../_helpers/mktAdv');

let A;
before(async () => { ({ a: A } = await tenants()); });
afterEach(() => clearCampaignSendPort());
after(async () => { await sequelize.close(); });
const at = (iso) => new Date(iso);

test('adv_14_campanha_encerrada_steps_nao_continuam: steps SCHEDULED e job PENDING cancelam; o runner bloqueia', async () => {
  await withRollbackTenantTransaction(A, async (t) => {
    const sent = [];
    registerCampaignSendPort({ canSend: async () => ({ allowed: true }), send: async (ctx) => { sent.push(ctx.actionKey); return { ok: true }; } });
    const templateId = await makeTemplate(t, A);
    const { itemId, versionId } = await insertContent(t, A, { itemStatus: 'APPROVED' });
    const personIds = [await makePerson(t, A)];
    const body = completeBody({ templateId, personIds, startsAt: '2031-12-01T09:00:00', endsAt: '2031-12-10T18:00:00', steps: [
      { channel: 'EMAIL', templateId, offsetMinutes: 0 },
      { channel: 'EMAIL', templateId, offsetMinutes: 60 * 24 * 5 },
      { channel: 'EMAIL', templateId, offsetMinutes: 60 * 24 * 7 },
    ] });
    const { campaign } = await campaigns.saveCampaign(A, A.userId, { ...body, schedule: true }, { permissions: ['marketing:campaign:manage'] }, t);
    await q(t, 'UPDATE marketing.content_items SET campaign_id = :c WHERE id = :i', { c: campaign.id, i: itemId });
    const jobId = await insertJob(t, A, versionId);

    await lifecycle.runLifecycleTick(A, t, at('2031-12-01T12:00:00Z')); // a campanha começa e o 1º step sai
    assert.equal(sent.length, 1);
    assert.deepEqual((await loadSteps(t, campaign.id)).map((s) => s.status), ['SENT', 'SCHEDULED', 'SCHEDULED']);
    assert.equal((await assertCampaignRunning(campaign.id, A, t)).allowed, true);
    const [pending] = await q(t, 'SELECT status FROM marketing.publication_jobs WHERE id = :id', { id: jobId });
    assert.equal(pending.status, 'PENDING');

    await lifecycle.runLifecycleTick(A, t, at('2031-12-10T21:00:00Z')); // a campanha termina
    // (1) o efeito proibido não ocorreu: os steps pendentes cancelam e o job cancela; nada novo sai
    const steps = await loadSteps(t, campaign.id);
    assert.deepEqual(steps.map((s) => s.status), ['SENT', 'CANCELLED', 'CANCELLED'], 'o step enviado fica; os pendentes cancelam');
    assert.ok(steps.slice(1).every((s) => s.status_reason === 'CAMPAIGN_ENDED'));
    const [job] = await q(t, 'SELECT status, last_error_code FROM marketing.publication_jobs WHERE id = :id', { id: jobId });
    assert.deepEqual(job, { status: 'CANCELLED', last_error_code: 'CAMPAIGN_ENDED' });
    // (2) o motivo está registrado no runner
    assert.deepEqual(await assertCampaignRunning(campaign.id, A, t), { allowed: false, blockCode: 'CAMPAIGN_NOT_RUNNING', status: 'ENDED' });
    // forçar os steps de volta a SCHEDULED e rodar de novo não envia nada
    await q(t, "UPDATE marketing.campaign_steps SET status = 'SCHEDULED' WHERE campaign_id = :c AND status = 'CANCELLED' RETURNING id", { c: campaign.id });
    await lifecycle.runLifecycleTick(A, t, at('2031-12-20T00:00:00Z'));
    assert.equal(sent.length, 1, 'o runner recusou as ações da campanha encerrada');
    // isolamento (RLS): a outra empresa não enxerga os steps nem o job
    await adv.assertIsolated(t, A, [{ tabela: 'marketing.campaign_steps', ids: steps.map((s) => s.id) }, { tabela: 'marketing.publication_jobs', ids: [jobId] }]);
  });
});
