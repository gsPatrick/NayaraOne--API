'use strict';

// M9-D406 — duas execuções simultâneas do mesmo passo (2 conexões, COMMIT real): uma vence, a outra recebe o resultado gravado.
// Só em banco descartável com DATABASE_ADMIN_URL (as transações concorrentes COMMITAM; a limpeza usa a conexão de administração).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { Client } = require('pg');
const { sequelize } = require('../src/models');
const { withTenantTransaction } = require('./testHelpers');
const { prepararTenants } = require('./helpers/marketingExecucao');
const fx = require('./helpers/m9d406Fixtures');
const service = require('../src/features/marketing/content/content.service');

const DISPOSABLE = process.env.DISPOSABLE_DB === '1' && Boolean(process.env.DATABASE_ADMIN_URL);
const SKIP = !DISPOSABLE && 'precisa do banco descartável (transações concorrentes COMMITAM)';
let tenant;
before(async () => { ({ tenantA: tenant } = await prepararTenants()); });
after(async () => { await sequelize.close(); });

async function adminCleanup(itemIds, templateCode) {
  const admin = new Client({ connectionString: process.env.DATABASE_ADMIN_URL });
  await admin.connect();
  try {
    await admin.query('UPDATE marketing.content_items SET current_version_id = NULL WHERE id = ANY($1)', [itemIds]);
    await admin.query('DELETE FROM marketing.publication_jobs WHERE content_version_id IN (SELECT id FROM marketing.content_versions WHERE content_item_id = ANY($1))', [itemIds]);
    await admin.query('DELETE FROM marketing.content_versions WHERE content_item_id = ANY($1)', [itemIds]);
    await admin.query('DELETE FROM marketing.content_items WHERE id = ANY($1)', [itemIds]);
    if (templateCode) await admin.query('DELETE FROM marketing.templates WHERE code = $1', [templateCode]);
  } finally { await admin.end(); }
}

test('duas_execucoes_simultaneas_do_mesmo_passo: aplicar a marca em paralelo cria UMA versão; o outro recebe o resultado gravado', { skip: SKIP }, async () => {
  const tx = (fn) => withTenantTransaction(tenant, fn);
  const tpl = await tx((t) => fx.publishedTemplate(t, tenant));
  const { itemId } = await tx((t) => service.createContent({ tenant, actor: tenant.userId, input: { type: 'INSTITUTIONAL', title: 'QA-M9 corrida', texto: 'Texto sem números.' } }, t));
  try {
    const factual = await tx((t) => service.runFactualCheck({ tenant, actor: tenant.userId, itemId }, t));
    assert.equal(factual.status, 'FACT_CHECKED');
    const ctx = { tenant, actor: tenant.userId, itemId, templateId: tpl.id, variables: { bairro: 'Centro', preco: 100 } };
    const results = await Promise.all([1, 2, 3].map(() => tx((t) => service.applyTemplate(ctx, t))));
    assert.equal(results.filter((r) => r.replay === false).length, 1, 'exatamente uma execução vence');
    assert.equal(results.filter((r) => r.replay === true).length, 2, 'as outras recebem o resultado gravado');
    assert.ok(results.every((r) => r.status === 'BRANDED'));
    const versions = await tx((t) => fx.versionsOf(t, itemId));
    assert.equal(versions.length, 2, 'versão 1 e a versão com a marca; nenhuma duplicada');

    // agendamento simultâneo do mesmo instante: um job por canal, nunca dois
    await tx((t) => service.runFactualCheck({ tenant, actor: tenant.userId, itemId }, t));
    const comp = await tx((t) => service.applyCompliance({ tenant, actor: tenant.userId, itemId }, t));
    assert.equal(comp.status, 'COMPLIANCE_CHECKED');
    const pending = await Promise.all([1, 2].map(() => tx((t) => service.requestApprovalIfRequired({ tenant, actor: tenant.userId, itemId }, t))));
    assert.equal(pending.filter((r) => r.replay === false).length, 1);
  } finally {
    await adminCleanup([itemId], tpl.code);
  }
});
