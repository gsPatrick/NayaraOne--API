'use strict';

// M9-D436 adv_07 (Caderno §16: "Kill switch ativo -> nenhuma ação outbound"). Kill switch global ligado; um lead novo, uma publicação agendada e um step de campanha são disparados: nenhuma
// chamada ao adapter, runs BLOCKED KILL_SWITCH, jobs PENDING, steps SCHEDULED e as tarefas internas criadas. Cenário da dona (M9-D425), sem lógica própria. Banco descartável.
const { allowTestUrls } = require('../../_helpers/mktUrlPolicy');
const { test, before, beforeEach, afterEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { sequelize } = require('../../../../src/models');
const leads = require('../../_helpers/mktLeads');
const worker = require('../../_helpers/mktWorker');
const adv = require('../../_helpers/mktAdv');
const lifecycle = require('../../../../src/features/marketing/campaigns/lifecycle.service');
const { registerCampaignSendPort, clearCampaignSendPort } = require('../../../../src/features/marketing/campaigns/sendPort');
const { upsertSetting } = require('../../../../src/features/settings/settings.service');

const TICK = new Date('2031-12-01T12:00:10Z');
let A;
let ctx;
let offVault;
before(async () => { ({ tenantA: A } = await leads.prepararTenants()); offVault = leads.useTempSecretStore(); ctx = await worker.setup(); });
beforeEach(() => { adv.adapters.resetSandbox(); registerCampaignSendPort(adv.messaging.buildMessagingCampaignPort()); });
afterEach(() => { clearCampaignSendPort(); worker.reset(); worker.resetSandbox(); });
after(async () => { offVault(); await sequelize.close(); });

test('adv_07_kill_switch_ativo_nenhuma_acao_outbound: lead novo, publicação agendada e step de campanha', async () => {
  await leads.withRollbackTenantTransaction(A, async (t) => {
    await allowTestUrls(t, A); // M9-D433: o link de descadastro passa pela regra de URL externa
    await upsertSetting('marketing.email.url_descadastro', 'https://www.exemplo.test/descadastro?t={token}', A, A.userId, t);
    await leads.install(t, A, 'LEAD-NOVO');
    const lead = await leads.lead(t, A, {});
    const campaignPeople = [await leads.readyPerson(t, A), await leads.readyPerson(t, A)];
    const campaign = await adv.scheduledCampaign(t, A, campaignPeople);
    const post = await worker.scheduled(t, ctx, ['SITE']);
    const before = { EMAIL: adv.sandboxCount(A, 'EMAIL'), WHATSAPP: adv.sandboxCount(A, 'WHATSAPP'), SITE: adv.sandboxCount(ctx.tenant, 'SITE') };

    await adv.on(t, A, 'GLOBAL');

    // lead novo: run BLOCKED KILL_SWITCH, a mensagem não sai e a tarefa interna é criada
    const out = await leads.run(t, A, leads.leadEvent(A, lead));
    const row = await leads.runRow(t, out.runs[0].runId);
    assert.deepEqual([row.status, row.blocked_reason], ['BLOCKED', 'KILL_SWITCH']);
    assert.equal(leads.sendEntry(row).status, 'SKIPPED');
    assert.equal(leads.entry(row, 'CREATE_TASK').status, 'OK', 'ação interna executa');
    assert.ok(await adv.taskOf(t, A, lead.personId), 'tarefa interna criada');
    assert.equal((await leads.outbound(t, lead.personId)).length, 0);

    // publicação agendada: o job espera PENDING e o worker não chama o canal
    await worker.cycle(t, ctx, { now: post.now });
    const job = await worker.job(t, post.jobId);
    assert.equal(job.status, 'PENDING');
    assert.equal(job.attempts, 0, 'nenhuma tentativa gasta');

    // step de campanha: continua SCHEDULED e nenhum destinatário é registrado
    await lifecycle.runLifecycleTick(A, t, TICK);
    assert.equal((await adv.deliveries(t, campaign.id)).length, 0);
    assert.ok((await adv.q(t, 'SELECT status FROM marketing.campaign_steps WHERE campaign_id = :c', { c: campaign.id })).every((s) => s.status === 'SCHEDULED'));
    // isolamento (RLS): a outra empresa não enxerga o que este cenário gravou
    await adv.assertIsolated(t, A, [{ tabela: 'marketing.automation_runs', ids: [row.id] }, { tabela: 'marketing.campaigns', ids: [campaign.id] }, { tabela: 'marketing.publication_jobs', ids: [post.jobId] }]);

    // (1) nenhuma chamada ao adapter em canal nenhum
    assert.deepEqual({ EMAIL: adv.sandboxCount(A, 'EMAIL'), WHATSAPP: adv.sandboxCount(A, 'WHATSAPP'), SITE: adv.sandboxCount(ctx.tenant, 'SITE') }, before);
    // (2) o motivo foi registrado e a reativação devolve o trabalho
    const log = await adv.ks.listKillSwitchLog(A, { scope: 'GLOBAL' }, t);
    assert.equal(log.slice(-1)[0].action, 'ACTIVATE');
    await adv.off(t, A, 'GLOBAL');
    await worker.cycle(t, ctx, { now: new Date(post.now.getTime() + 60000) });
    assert.equal((await worker.job(t, post.jobId)).status, 'PUBLISHED', 'o job pendente é processado depois da reativação');
  });
});
