'use strict';

// Marco 9, M9-D208 (reabertura) — a falha do ciclo de sync vira linha em integration.integration_errors (livro 3.2 item 4).
// Os ciclos COMMITAM: rodar em banco descartável (node scripts/withDisposableDb.js ...).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { sequelize, getSeedTenant, uniqueSuffix } = require('../testHelpers');
const { IntegrationConnection, IntegrationProvider, IntegrationError, IntegrationSyncCursor } = require('../../src/models');
const registry = require('../../src/features/integrations/registry/registry.service');
const { runSyncCycle } = require('../../src/features/integrations/sync/sync.runner');

let tenant;
let ctx;

async function comTenant(fn) {
  const t = await sequelize.transaction();
  try {
    await sequelize.query('SET LOCAL app.group_id = :g', { replacements: { g: tenant.groupId }, transaction: t });
    await sequelize.query('SET LOCAL app.company_id = :c', { replacements: { c: tenant.companyId }, transaction: t });
    await sequelize.query('SET LOCAL app.user_id = :u', { replacements: { u: tenant.userId }, transaction: t });
    const out = await fn(t);
    await t.commit();
    return out;
  } catch (err) {
    await t.rollback();
    throw err;
  }
}

before(async () => {
  tenant = await getSeedTenant();
  ctx = { groupId: tenant.groupId, companyId: tenant.companyId, userId: tenant.userId };
});
after(async () => { await sequelize.close(); });

async function conexao() {
  const provider = await IntegrationProvider.findOne({ where: { domain: 'BANK', status: 'ACTIVE', sandboxAvailable: true } });
  assert.ok(provider, 'sem fornecedor sandbox BANK');
  return comTenant(async (t) => {
    await sequelize.query("UPDATE integration.connections SET status = 'PAUSED' WHERE company_id = :c AND provider_code = :p AND environment = 'SANDBOX' AND status = 'ACTIVE'", { replacements: { c: tenant.companyId, p: provider.code }, transaction: t });
    const c = await registry.createConnection({ providerCode: provider.code, environment: 'SANDBOX', label: `QA-M9 ${uniqueSuffix()}` }, ctx, t);
    await sequelize.query("UPDATE integration.connections SET status = 'ACTIVE' WHERE id = :id", { replacements: { id: c.id }, transaction: t });
    return c;
  });
}

const falha = (code) => ({
  async fetchPage() { const e = new Error('corpo secreto do provider: token=abc123'); if (code) e.code = code; throw e; },
  async applyItems() { return 0; },
});
const ciclo = (c, stream, src, extra = {}) => runSyncCycle({ connectionId: c.id, stream, workerId: `w-${uniqueSuffix()}`, ...extra }, ctx, src);
const linhas = (cursorId) => comTenant((t) => IntegrationError.findAll({ where: { source: 'SYNC', financingCaseId: cursorId }, transaction: t }));

test('sync_falha_grava_integration_errors_por_padrao', async () => {
  const c = await conexao();
  const r = await ciclo(c, 'bank.statement', falha('PROVIDER_TIMEOUT'));
  assert.equal(r.status, 'FAILED');
  const cursor = await comTenant((t) => IntegrationSyncCursor.findOne({ where: { connectionId: c.id, stream: 'bank.statement' }, transaction: t }));
  const rows = await linhas(cursor.id);
  assert.equal(rows.length, 1, 'uma linha SYNC com source_ref_id = id do cursor');
  assert.equal(rows[0].errorCode, 'PROVIDER_TIMEOUT');
  assert.equal(rows[0].connectionId, c.id);
  assert.equal(rows[0].providerCode, c.providerCode);
  assert.ok(!/abc123|secreto/.test(`${rows[0].message}${JSON.stringify(rows[0].sanitizedPayload)}`), 'nada do corpo do provider');

  await ciclo(c, 'bank.statement', falha('PROVIDER_TIMEOUT'));
  const depois = await linhas(cursor.id);
  assert.equal(depois.length, 1, 'mesma falha agrupa');
  assert.equal(depois[0].attempts, 2);
});

test('sync_falha_reverte_junto_se_o_registro_do_erro_falhar', async () => {
  const c = await conexao();
  const quebrado = async () => { throw new Error('gravação do erro caiu'); };
  await assert.rejects(ciclo(c, 'bank.statement', falha('X_FAIL'), { recordError: quebrado }), /gravação do erro caiu/);
  const cursor = await comTenant((t) => IntegrationSyncCursor.findOne({ where: { connectionId: c.id, stream: 'bank.statement' }, transaction: t }));
  assert.equal(cursor.consecutiveFailures, 0, 'contagem não avança sem o erro registrado (mesma transação)');
});
