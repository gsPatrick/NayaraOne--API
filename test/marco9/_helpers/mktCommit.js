'use strict';

// Apoio dos testes de concorrência do Marketing (M9-D416/M9-D418): dados COMMITADOS em conexões separadas e limpeza pelo
// superusuário do banco descartável. Só roda com DISPOSABLE_DB=1 e DATABASE_ADMIN_URL. Não é teste.
const { Client } = require('pg');
const { withTenantTransaction } = require('../../testHelpers');
const env = require('./mktPolicyEnv');

const DISPOSABLE = process.env.DISPOSABLE_DB === '1' && Boolean(process.env.DATABASE_ADMIN_URL);
const SKIP = !DISPOSABLE && 'precisa do banco descartável (as transações concorrentes COMMITAM)';

/** Cria (com COMMIT) pessoa pronta, fluxo e N runs STARTED. Devolve ids para a limpeza. */
async function committedFixture(tenant, runs = 2) {
  return withTenantTransaction(tenant, async (t) => {
    const personId = await env.readyPerson(t, tenant);
    const flow = await env.makeFlowVersion(t, tenant);
    const runIds = [];
    for (let i = 0; i < runs; i += 1) runIds.push(await env.makeRun(t, tenant, { versionId: flow.versionId, personId, status: 'STARTED' }));
    return { personId, flowId: flow.flowId, versionId: flow.versionId, runIds };
  });
}

/** Apaga tudo que a fixture e os testes deixaram (superusuário; ignora RLS). */
async function cleanup({ personId, flowId }) {
  const admin = new Client({ connectionString: process.env.DATABASE_ADMIN_URL });
  await admin.connect();
  try {
    await admin.query('DELETE FROM integration.outbox_events WHERE aggregate_id = $1', [personId]).catch(() => null);
    await admin.query('DELETE FROM marketing.suppression_list WHERE person_id = $1', [personId]);
    await admin.query('DELETE FROM marketing.automation_runs WHERE subject_id = $1', [personId]);
    await admin.query('UPDATE marketing.automation_flows SET published_version_id = NULL WHERE id = $1', [flowId]);
    await admin.query('DELETE FROM marketing.automation_versions WHERE flow_id = $1', [flowId]);
    await admin.query('DELETE FROM marketing.automation_flows WHERE id = $1', [flowId]);
    await admin.query('DELETE FROM crm.messages WHERE person_id = $1', [personId]);
    await admin.query('DELETE FROM people.communication_consents WHERE person_id = $1', [personId]);
    await admin.query('DELETE FROM people.person_contacts WHERE person_id = $1', [personId]);
    await admin.query('DELETE FROM people.persons WHERE id = $1', [personId]);
  } finally { await admin.end(); }
}

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

module.exports = { DISPOSABLE, SKIP, committedFixture, cleanup, sleep, withTenantTransaction };
