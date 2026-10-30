'use strict';

// M9-D411 — dois workers ao mesmo tempo (COMMIT real): o job é pego por um só (FOR UPDATE SKIP LOCKED) e o canal recebe um único post.
// Só em banco descartável com DATABASE_ADMIN_URL.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { Client } = require('pg');
const { sequelize } = require('../../../src/models');
const { withTenantTransaction } = require('../../testHelpers');
const env = require('../_helpers/mktWorker');
const { adapters } = require('../../../src/features/marketing/publications');

const DISPOSABLE = process.env.DISPOSABLE_DB === '1' && Boolean(process.env.DATABASE_ADMIN_URL);
const SKIP = !DISPOSABLE && 'precisa do banco descartável (as transações concorrentes COMMITAM)';
let ctx;
before(async () => { ctx = await env.setup(); });
after(async () => { await sequelize.close(); });

async function adminCleanup(itemId) {
  const admin = new Client({ connectionString: process.env.DATABASE_ADMIN_URL });
  await admin.connect();
  try {
    await admin.query('SET session_replication_role = replica');
    const jobs = 'SELECT id FROM marketing.publication_jobs WHERE content_version_id IN (SELECT id FROM marketing.content_versions WHERE content_item_id = $1)';
    await admin.query(`DELETE FROM marketing.publication_results WHERE job_id IN (${jobs})`, [itemId]);
    await admin.query('DELETE FROM integration.dispatches WHERE aggregate_id = $1', [itemId]);
    await admin.query(`DELETE FROM integration.outbox_events WHERE aggregate_id IN (${jobs})`, [itemId]);
    await admin.query(`DELETE FROM marketing.publication_jobs WHERE id IN (${jobs})`, [itemId]);
    await admin.query('UPDATE marketing.content_items SET current_version_id = NULL WHERE id = $1', [itemId]);
    await admin.query('DELETE FROM marketing.content_versions WHERE content_item_id = $1', [itemId]);
    await admin.query('DELETE FROM marketing.content_items WHERE id = $1', [itemId]);
  } finally { await admin.end(); }
}

test('dois_workers_um_job', { skip: SKIP }, async () => {
  env.resetSandbox();
  const tx = (fn) => withTenantTransaction(ctx.tenant, fn);
  const created = await tx((t) => env.pendingInstitutional(t, ctx));
  const itemId = created.itemId;
  try {
    await tx((t) => env.service.approve({ tenant: ctx.tenant, actor: ctx.reviewer, itemId, input: {} }, t));
    const when = env.inMinutes(120);
    const scheduled = await tx((t) => env.schedule(t, ctx, itemId, { channels: ['SITE'], when: when.toISOString() }));
    const now = new Date(when.getTime() + 60000);
    const runs = await Promise.all([1, 2, 3, 4].map(() => env.runWorkerCycle(ctx.tenant, { withTx: tx, now })));
    assert.equal(runs.reduce((sum, r) => sum + r.claimed, 0), 1, 'o job é pego por um único worker');
    const rows = await tx((t) => env.fx.q(t, 'SELECT id, status, attempts FROM marketing.publication_jobs WHERE content_version_id = :v ORDER BY channel', { v: created.versionId }));
    assert.deepEqual(rows.map((r) => [r.status, r.attempts]), [['PUBLISHED', 1]]);
    assert.equal(adapters.sandboxRecordCount(ctx.tenant.companyId, 'SITE'), 1, 'um único post no canal');
    for (const job of scheduled.jobs) {
      const successes = (await tx((t) => env.results(t, job.id))).filter((r) => r.outcome === 'SUCCESS');
      assert.equal(successes.length, 1, 'um único resultado de sucesso por job');
    }
    assert.equal(await tx((t) => env.itemStatus(t, itemId)), 'PUBLISHED');
  } finally { await adminCleanup(itemId); }
});

test('worker_so_pega_job_de_cada_vez_mesmo_com_o_envio_demorando', { skip: SKIP }, async () => {
  env.resetSandbox();
  const tx = (fn) => withTenantTransaction(ctx.tenant, fn);
  const created = await tx((t) => env.pendingInstitutional(t, ctx));
  const itemId = created.itemId;
  const restore = env.overrideSandbox('SITE', (adapter) => { adapter.slowMs = 400; return adapter; });
  try {
    await tx((t) => env.service.approve({ tenant: ctx.tenant, actor: ctx.reviewer, itemId, input: {} }, t));
    const when = env.inMinutes(120);
    await tx((t) => env.schedule(t, ctx, itemId, { channels: ['SITE'], when: when.toISOString() }));
    const now = new Date(when.getTime() + 60000);
    // o segundo worker começa enquanto o primeiro ainda está falando com o canal (job já em RUNNING, reserva commitada)
    const first = env.runWorkerCycle(ctx.tenant, { withTx: tx, now, scenarioFor: () => 'SLOW' });
    await new Promise((resolve) => { setTimeout(resolve, 150); });
    const second = await env.runWorkerCycle(ctx.tenant, { withTx: tx, now });
    assert.equal(second.claimed, 0, 'job RUNNING não é pego de novo');
    assert.equal((await first).claimed, 1);
    assert.equal(adapters.sandboxRecordCount(ctx.tenant.companyId, 'SITE'), 1);
  } finally { restore(); await adminCleanup(itemId); }
});
