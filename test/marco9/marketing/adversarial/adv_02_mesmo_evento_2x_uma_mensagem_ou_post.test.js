'use strict';

// M9-D436 adv_02 (Caderno §16: "Mesmo evento 2x -> uma mensagem/post"). O mesmo evento duas vezes e também de outra conexão (outro eventId para a mesma oportunidade) gera 1 run e 1 mensagem;
// o mesmo post agendado duas vezes gera 1 job e 1 post no sandbox. Cenários das donas (M9-D415, M9-D410/M9-D411), sem lógica própria. Banco descartável.
const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { sequelize } = require('../../../../src/models');
const leads = require('../../_helpers/mktLeads');
const worker = require('../../_helpers/mktWorker');
const adv = require('../../_helpers/mktAdv');

let A;
let ctx;
let offVault;
before(async () => { ({ tenantA: A } = await leads.prepararTenants()); offVault = leads.useTempSecretStore(); ctx = await worker.setup(); });
after(async () => { offVault(); await sequelize.close(); });
afterEach(() => { worker.reset(); worker.resetSandbox(); });

test('adv_02_mesmo_evento_2x_uma_mensagem_ou_post: evento repetido e vindo de duas conexões gera 1 run e 1 mensagem', async () => {
  await leads.withRollbackTenantTransaction(A, async (t) => {
    await leads.install(t, A, 'LEAD-NOVO');
    const lead = await leads.lead(t, A, {});
    const event = leads.leadEvent(A, lead);
    const first = await leads.run(t, A, event);
    const again = await leads.run(t, A, event); // o mesmo evento outra vez
    const other = await leads.run(t, A, leads.leadEvent(A, lead, { eventId: leads.uid() })); // a mesma oportunidade vinda de outra conexão
    // (1) o efeito proibido não ocorreu: uma só mensagem, uma só tarefa, uma só run
    assert.equal((await leads.outbound(t, lead.personId)).length, 1, 'uma única mensagem');
    assert.equal((await leads.tasksOf(t, A, lead.personId)).filter((r) => r.title === 'Contatar lead novo').length, 1, 'uma única tarefa');
    const runs = await adv.q(t, 'SELECT id FROM marketing.automation_runs WHERE subject_id = :p OR subject_id = :o', { p: lead.personId, o: lead.opportunityId });
    assert.equal(runs.length, 1, 'uma única run');
    // (2) o motivo foi registrado: duplicidade devolvida como replay, apontando para a mesma run
    assert.equal(again.duplicate, true);
    assert.equal(other.runs[0].replay, true);
    assert.equal(other.runs[0].runId, first.runs[0].runId);
    // isolamento (RLS): a outra empresa não enxerga o que este cenário gravou
    await adv.assertIsolated(t, A, [{ tabela: 'marketing.automation_runs', ids: [first.runs[0].runId] }]);
  });
});

test('adv_02_mesmo_evento_2x_uma_mensagem_ou_post: o mesmo post agendado duas vezes gera 1 job e 1 post no sandbox', async () => {
  await worker.withRollbackTenantTransaction(ctx.tenant, async (t) => {
    const s = await worker.scheduled(t, ctx, ['SITE']);
    const again = await worker.schedule(t, ctx, s.itemId, { channels: ['SITE'], when: s.when.toISOString() });
    const jobs = await adv.q(t, 'SELECT id, idempotency_key FROM marketing.publication_jobs WHERE content_version_id IN (SELECT id FROM marketing.content_versions WHERE content_item_id = :i)', { i: s.itemId });
    // (1) um único job para o item e canal, mesmo agendando duas vezes
    assert.equal(jobs.length, 1);
    assert.equal(again.jobs[0].id, s.jobId, 'o segundo agendamento devolve o mesmo job');
    // rodar o worker duas vezes publica uma vez só
    await worker.cycle(t, ctx, { now: s.now });
    await worker.cycle(t, ctx, { now: new Date(s.now.getTime() + 60000) });
    assert.equal(adv.sandboxCount(ctx.tenant, 'SITE'), 1, 'um único post no sandbox');
    // (2) o motivo/estado ficou registrado: job PUBLISHED com uma tentativa e um resultado de sucesso
    const job = await worker.job(t, s.jobId);
    assert.equal(job.status, 'PUBLISHED');
    assert.equal(job.attempts, 1);
    assert.equal((await worker.results(t, s.jobId)).filter((r) => r.outcome === 'SUCCESS').length, 1);
    // isolamento (RLS): a outra empresa não enxerga o que este cenário gravou
    await adv.assertIsolated(t, ctx.tenant, [{ tabela: 'marketing.publication_jobs', ids: [s.jobId] }]);
  });
});
