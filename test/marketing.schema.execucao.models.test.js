'use strict';

// M9-D401 — schema marketing parte 2 (erros MKT, models Sequelize e ciclo da migration). Roda com nayara_runtime (RLS real) em transação com rollback.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { Sequelize } = require('sequelize');

const { sequelize } = require('../src/models');
const {
  TABLES, base, prepararTenants, sha, uid,
} = require('./helpers/marketingExecucao');
const { withRollbackTenantTransaction } = require('./testHelpers');
const { recomporMarketing } = require('./helpers/marketingRecompoe');

// Migrations posteriores que alteram as tabelas da parte 2 (D414 definição da automação; D431 atribuição e links).
const RECIBOS = '20260101000772-marketing-automation-action-receipts.js'; // M9-D414: o recibo das ações aponta para automation_runs e cai antes da parte 2

let tenantA;

before(async () => {
  ({ tenantA } = await prepararTenants());
});

after(async () => {
  await sequelize.close();
});

test('erros_da_parte_2_viram_codigos_mkt_em_portugues', async () => {
  const errorHandler = require('../src/middlewares/errorHandler');
  const chamar = (parent) => {
    const out = {};
    const res = { status(c) { out.status = c; return this; }, json(b) { out.body = b; return this; }, getHeader() { return undefined; } };
    errorHandler(Object.assign(new Error('x'), { name: 'SequelizeDatabaseError', parent }), { method: 'POST', originalUrl: '/x' }, res, () => {});
    return out;
  };
  const a = chamar({ code: 'MK002', message: 'MKT_RESULT_APPEND_ONLY' });
  assert.equal(a.status, 409);
  assert.equal(a.body.error.code, 'MKT_RESULT_APPEND_ONLY');
  assert.equal(a.body.error.message, 'O resultado de publicação não pode ser alterado.');
  const b = chamar({ code: 'MK003', message: 'MKT_AUTOMATION_VERSION_IMMUTABLE' });
  assert.equal(b.status, 409);
  assert.equal(b.body.error.code, 'MKT_AUTOMATION_VERSION_IMMUTABLE');
  assert.equal(b.body.error.message, 'A versão publicada é imutável; crie uma nova versão.');
});

test('models_sequelize_da_parte_2_gravam_e_leem_sob_rls_e_replay_da_run', async () => {
  const models = require('../src/models');
  const { MarketingAutomationFlow, MarketingAutomationVersion, MarketingAutomationRun, MarketingSuppression, MarketingTrackingLink,
    MarketingAttributionEvent, MarketingPublicationJob, MarketingPublicationResult, MarketingReviewRequest } = models;
  for (const m of [MarketingAutomationFlow, MarketingAutomationVersion, MarketingAutomationRun, MarketingSuppression, MarketingTrackingLink,
    MarketingAttributionEvent, MarketingPublicationJob, MarketingPublicationResult, MarketingReviewRequest]) assert.ok(m, 'modelo ausente');
  const { createRunIdempotent } = require('../src/features/marketing/automationRuns.repository');
  await withRollbackTenantTransaction(tenantA, async (transaction) => {
    const b = { groupId: tenantA.groupId, companyId: tenantA.companyId };
    const flow = await MarketingAutomationFlow.create({ ...b, code: `F-${uid().slice(0, 6)}`, name: 'QA-M9', ownerUserId: tenantA.userId, riskLevel: 'LOW' }, { transaction });
    const ver = await MarketingAutomationVersion.create({ ...b, flowId: flow.id, versionNo: 1, triggerType: 'EVENT', actions: [], riskLevel: 'LOW', contentHash: sha('m') }, { transaction });
    const key = `run:${uid()}`;
    const dados = { ...b, automationVersionId: ver.id, correlationId: uid(), idempotencyKey: key, subjectType: 'PERSON', subjectId: uid() };
    const r1 = await createRunIdempotent(dados, { transaction });
    assert.equal(r1.replay, false);
    const r2 = await createRunIdempotent({ ...dados, correlationId: uid() }, { transaction });
    assert.equal(r2.replay, true);
    assert.equal(r2.code, 'MKT_RUN_REPLAY');
    assert.equal(r2.message, 'Esta execução já foi processada.');
    assert.equal(r2.run.id, r1.run.id);
    const n = await MarketingAutomationRun.count({ where: { idempotencyKey: key }, transaction });
    assert.equal(n, 1);
    await MarketingSuppression.create({ ...b, addressHash: sha('a@b.test'), channel: 'EMAIL', reason: 'OPT_OUT', source: 'QA-M9' }, { transaction });
    await MarketingTrackingLink.create({ ...b, shortCode: uid().slice(0, 10), targetUrl: 'https://exemplo.test', channel: 'SITE', signature: sha('s') }, { transaction });
    await MarketingAttributionEvent.create({ ...b, eventType: 'CLICK', touchRoles: ['FIRST', 'LAST'], evidenceJson: { a: 1 }, occurredAt: new Date() }, { transaction });
  });
});

test('migration_da_parte_2_e_idempotente_e_reversivel', async (t) => {
  if (process.env.DISPOSABLE_DB !== '1' || !process.env.DATABASE_ADMIN_URL) {
    t.skip('só roda no banco descartável (DISPOSABLE_DB=1 e DATABASE_ADMIN_URL)');
    return;
  }
  const admin = new Sequelize(process.env.DATABASE_ADMIN_URL, { logging: false });
  const migration = require(path.resolve(__dirname, '../migrations/20260101000751-marketing-schema-parte-2.js'));
  const qi = admin.getQueryInterface();
  const contagem = async () => (await admin.query("SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'marketing' AND table_name IN (:t)", { replacements: { t: TABLES } }))[0][0].n;
  try {
    assert.equal(await contagem(), 9);
    await migration.up(qi);
    assert.equal(await contagem(), 9);
    await admin.query(`INSERT INTO marketing.suppression_list (group_id, company_id, address_hash, channel, reason, source, active)
      VALUES (:g, :c, :h, 'EMAIL', 'OPT_OUT', 'DOWN-TEST', true)`, { replacements: { ...base(tenantA), h: sha('down') } });
    await assert.rejects(() => migration.down(qi), /MKT_MIGRATION_DOWN_NOT_EMPTY|não está vazi/i);
    assert.equal(await contagem(), 9);
    await admin.query("DELETE FROM marketing.suppression_list WHERE source = 'DOWN-TEST'");
    await require(path.resolve(__dirname, '../migrations', RECIBOS)).down(qi);
    await migration.down(qi);
    assert.equal(await contagem(), 0);
    await migration.up(qi);
    assert.equal(await contagem(), 9);
  } finally {
    // O down derruba as tabelas com tudo que as migrations posteriores acrescentaram (colunas, checks, gatilhos): recompõe na ordem
    // MESMO se uma asserção falhar, para o teste ser reexecutável no mesmo banco sem deixar o schema pela metade.
    await recomporMarketing(admin); // partes 1 e 2, TODAS as migrations posteriores de marketing e o GRANT do runtime (helpers/marketingRecompoe)
    await admin.close();
  }
});

