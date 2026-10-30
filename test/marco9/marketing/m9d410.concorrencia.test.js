'use strict';

// M9-D410 — duas conexões agendando o mesmo conteúdo ao mesmo tempo (COMMIT real): uma cria, a outra recebe o job; horários diferentes: uma vence, a outra 409.
// Só em banco descartável com DATABASE_ADMIN_URL.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { Client } = require('pg');
const { sequelize } = require('../../../src/models');
const { withTenantTransaction } = require('../../testHelpers');
const env = require('../_helpers/mktAgenda');

const DISPOSABLE = process.env.DISPOSABLE_DB === '1' && Boolean(process.env.DATABASE_ADMIN_URL);
const SKIP = !DISPOSABLE && 'precisa do banco descartável (as transações concorrentes COMMITAM)';
let ctx;
before(async () => { ctx = await env.setup(); });
after(async () => { await sequelize.close(); });

async function adminCleanup(itemId) {
  const admin = new Client({ connectionString: process.env.DATABASE_ADMIN_URL });
  await admin.connect();
  try {
    await admin.query('UPDATE marketing.content_items SET current_version_id = NULL WHERE id = $1', [itemId]);
    await admin.query('DELETE FROM integration.dispatches WHERE aggregate_id = $1', [itemId]);
    await admin.query('DELETE FROM marketing.publication_jobs WHERE content_version_id IN (SELECT id FROM marketing.content_versions WHERE content_item_id = $1)', [itemId]);
    await admin.query('DELETE FROM marketing.content_versions WHERE content_item_id = $1', [itemId]);
    await admin.query('DELETE FROM marketing.content_items WHERE id = $1', [itemId]);
  } finally { await admin.end(); }
}

test('duas_conexoes_agendando_simultaneamente', { skip: SKIP }, async () => {
  const tx = (fn) => withTenantTransaction(ctx.tenant, fn);
  const created = await tx(async (t) => env.pendingItem(t, ctx));
  const itemId = created.itemId;
  try {
    await tx((t) => env.service.approve({ tenant: ctx.tenant, actor: ctx.reviewer, itemId, input: {} }, t));
    const body = { channels: ['SITE'], when: env.inMinutes(90).toISOString() };
    const results = await Promise.all([1, 2, 3].map(() => tx((t) => env.schedule(t, ctx, itemId, body))));
    assert.equal(results.filter((r) => r.replay === false).length, 1, 'exatamente uma cria');
    assert.equal(new Set(results.map((r) => r.jobs[0].id)).size, 1, 'todas recebem o mesmo job');
    const different = await Promise.allSettled([1, 2].map((n) => tx((t) => env.schedule(t, ctx, itemId, { channels: ['SITE'], when: env.inMinutes(200 + n * 10).toISOString() }))));
    assert.ok(different.every((r) => r.status === 'rejected' && r.reason.code === 'MKT_JOB_ALREADY_ACTIVE'), 'horário diferente com job ativo: 409 nas duas');
    const jobs = await tx((t) => env.fx.q(t, 'SELECT id FROM marketing.publication_jobs WHERE content_version_id = :v', { v: created.versionId }));
    assert.equal(jobs.length, 1);
  } finally { await adminCleanup(itemId); }
});
