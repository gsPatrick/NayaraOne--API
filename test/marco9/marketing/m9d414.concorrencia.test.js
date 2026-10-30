'use strict';

// M9-D414 — corrida real (duas conexões, COMMIT): o mesmo evento em dois consumidores gera uma run e uma mensagem; dois executores das ações adiadas enviam uma vez
// (FOR UPDATE SKIP LOCKED). Só em banco descartável com DATABASE_ADMIN_URL; a limpeza usa a conexão de administração.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { Client } = require('pg');
const { sequelize } = require('../../../src/models');
const { withTenantTransaction } = require('../../testHelpers');
const env = require('../_helpers/mktRunner');

const DISPOSABLE = process.env.DISPOSABLE_DB === '1' && Boolean(process.env.DATABASE_ADMIN_URL);
const SKIP = !DISPOSABLE && 'precisa do banco descartável (as transações concorrentes COMMITAM)';
let tenant;
before(async () => { ({ tenantA: tenant } = await env.prepararTenants()); });
after(async () => { await sequelize.close(); });
const tx = (fn) => withTenantTransaction(tenant, fn);

async function cleanup({ personId, flowId, templateId }) {
  const admin = new Client({ connectionString: process.env.DATABASE_ADMIN_URL });
  await admin.connect();
  try {
    const runs = '(SELECT id FROM marketing.automation_runs WHERE subject_id = $1)';
    await admin.query(`DELETE FROM integration.outbox_events WHERE aggregate_id IN ${runs}`, [personId]);
    await admin.query(`DELETE FROM marketing.automation_action_receipts WHERE run_id IN ${runs}`, [personId]);
    await admin.query('DELETE FROM core.tasks WHERE related_entity_id = $1', [personId]);
    await admin.query('DELETE FROM marketing.automation_runs WHERE subject_id = $1', [personId]);
    await admin.query('UPDATE marketing.automation_flows SET published_version_id = NULL WHERE id = $1', [flowId]);
    await admin.query('DELETE FROM marketing.automation_versions WHERE flow_id = $1', [flowId]);
    await admin.query('DELETE FROM marketing.automation_flows WHERE id = $1', [flowId]);
    await admin.query("DELETE FROM integration.integration_inbox WHERE consumer_name = 'marketing.automation.runner' AND company_id = $1", [tenant.companyId]);
    await admin.query('DELETE FROM crm.messages WHERE person_id = $1', [personId]);
    await admin.query('DELETE FROM people.communication_consents WHERE person_id = $1', [personId]);
    await admin.query('DELETE FROM people.person_contacts WHERE person_id = $1', [personId]);
    await admin.query('DELETE FROM people.persons WHERE id = $1', [personId]);
    await admin.query('DELETE FROM marketing.templates WHERE id = $1', [templateId]);
  } finally { await admin.end(); }
}

async function fixture(actions) {
  return tx(async (t) => {
    const personId = await env.readyPerson(t, tenant);
    const flow = await env.publishedFlow(t, tenant, { actions });
    return { personId, ...flow };
  });
}

test('dois_consumidores_do_mesmo_evento: uma run, uma tarefa, os dois recebem o mesmo resultado', { skip: SKIP }, async () => {
  const f = await fixture([env.TASK({ title: 'Corrida QA-M9' })]);
  try {
    const event = env.eventFor(tenant, f.personId);
    const results = await Promise.allSettled([1, 2].map(() => tx((t) => env.run(t, tenant, event))));
    assert.ok(results.every((r) => r.status === 'fulfilled'), JSON.stringify(results.filter((r) => r.status === 'rejected').map((r) => r.reason && r.reason.message)));
    const runIds = new Set(results.flatMap((r) => r.value.runs.map((x) => x.runId)));
    assert.equal(runIds.size, 1, 'uma única run');
    const [{ n }] = await tx((t) => env.q(t, "SELECT count(*)::int AS n FROM core.tasks WHERE related_entity_id = :p AND title = 'Corrida QA-M9'", { p: f.personId }));
    assert.equal(n, 1, 'uma única tarefa');
    const started = await tx((t) => env.events(t, [...runIds][0]));
    assert.equal(started.filter((e) => e.event_type === 'automation.run.started').length, 1);
  } finally { await cleanup(f); }
});

test('dois_executores_das_acoes_adiadas_ao_mesmo_tempo: a mensagem sai uma vez (SKIP LOCKED)', { skip: SKIP }, async () => {
  const f = await fixture([env.SEND(), env.TASK({ title: 'Adiada QA-M9' })]);
  try {
    const out = await tx((t) => env.run(t, tenant, env.eventFor(tenant, f.personId), { now: env.NIGHT }));
    const runId = out.runs[0].runId;
    assert.equal((await tx((t) => env.runRow(t, runId))).status, 'WAITING');
    const due = () => tx((t) => env.runner.runDueActions(tenant, t, { now: env.MORNING, mode: 'SANDBOX' }));
    const [a, b] = await Promise.all([due(), due()]);
    assert.equal(a.processed + b.processed, 1, 'um executor pega a run, o outro a pula');
    const messages = await tx((t) => env.messagesOf(t, f.personId));
    assert.equal(messages.length, 1);
    assert.equal((await tx((t) => env.runRow(t, runId))).status, 'COMPLETED');
    assert.equal((await tx((t) => env.events(t, runId))).filter((e) => e.event_type === 'automation.run.completed').length, 1);
  } finally { await cleanup(f); }
});
