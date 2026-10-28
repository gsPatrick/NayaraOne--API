'use strict';

// M9-D406 — máquina de estados do content_items.status: tabela única, as 5 transições extras com seus executores e o resto recusado.
// Rodar só em banco descartável (veja m9d406.pipeline.test.js).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { sequelize } = require('../src/models');
const { withRollbackTenantTransaction } = require('./testHelpers');
const { prepararTenants } = require('./helpers/marketingExecucao');
const fx = require('./helpers/m9d406Fixtures');
const states = require('../src/features/marketing/content/pipeline.states');
const service = require('../src/features/marketing/content/content.service');
const approvalGuard = require('../src/features/marketing/content/approval.guard');
const { blockStaleItem } = require('../src/features/marketing/content/sourceStale');
const { archiveSupersededOnPublish } = require('../src/features/marketing/content/archiveSuperseded');
const { sourceFromProperty, createContentWithProvenance } = require('../src/features/marketing/content/contentProvenance');

let tenant;
before(async () => { ({ tenantA: tenant } = await prepararTenants()); });
after(async () => { await sequelize.close(); });

const ALL = ['DRAFT', 'FACT_CHECK_FAILED', 'FACT_CHECKED', 'BRANDED', 'COMPLIANCE_CHECKED', 'PENDING_APPROVAL', 'APPROVED', 'SCHEDULED',
  'PUBLISHING', 'PUBLISHED', 'FAILED', 'ARCHIVED'];

const MAIN_PAIRS = [
  ['DRAFT', 'FACT_CHECKED'], ['DRAFT', 'FACT_CHECK_FAILED'], ['FACT_CHECK_FAILED', 'DRAFT'], ['FACT_CHECKED', 'BRANDED'],
  ['BRANDED', 'COMPLIANCE_CHECKED'], ['COMPLIANCE_CHECKED', 'PENDING_APPROVAL'], ['COMPLIANCE_CHECKED', 'APPROVED'],
  ['PENDING_APPROVAL', 'APPROVED'], ['PENDING_APPROVAL', 'DRAFT'], ['APPROVED', 'SCHEDULED'], ['SCHEDULED', 'PUBLISHING'],
  ['PUBLISHING', 'PUBLISHED'], ['PUBLISHING', 'FAILED'], ['FAILED', 'SCHEDULED'],
];
const BEFORE_PUBLISHING = ['DRAFT', 'FACT_CHECK_FAILED', 'FACT_CHECKED', 'BRANDED', 'COMPLIANCE_CHECKED', 'PENDING_APPROVAL', 'APPROVED', 'SCHEDULED'];
const EXTRA_PAIRS = [
  ...BEFORE_PUBLISHING.filter((s) => s !== 'FACT_CHECK_FAILED').map((s) => [s, 'FACT_CHECK_FAILED']),
  ['APPROVED', 'PENDING_APPROVAL'], ['SCHEDULED', 'PENDING_APPROVAL'], ['PUBLISHED', 'ARCHIVED'], ['SCHEDULED', 'PUBLISHING'], ['SCHEDULED', 'APPROVED'],
];
const ARCHIVE_PAIRS = BEFORE_PUBLISHING.map((s) => [s, 'ARCHIVED']);

test('a_tabela_de_transicoes_aceita_so_o_que_o_livro_permite', () => {
  const allowed = new Set([...MAIN_PAIRS, ...EXTRA_PAIRS, ...ARCHIVE_PAIRS].map((p) => p.join('>')));
  for (const from of ALL) {
    for (const to of ALL) {
      assert.equal(states.canTransition(from, to), allowed.has(`${from}>${to}`), `${from} -> ${to}`);
    }
  }
  assert.throws(() => states.assertTransition('DRAFT', 'APPROVED'), (e) => e.statusCode === 409 && e.code === 'MKT_CONTENT_INVALID_TRANSITION' && /DRAFT -> APPROVED/.test(e.message));
});

async function seedItem(t, status) {
  const { itemId } = await service.createContent({ tenant, actor: tenant.userId, input: { type: 'INSTITUTIONAL', title: 'QA-M9 estado', texto: 'Texto.' } }, t);
  await fx.setStatus(t, itemId, status);
  return itemId;
}

test('as_cinco_transicoes_extras_sao_aceitas_e_o_resto_recusado', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    // (1) fonte desatualizada: qualquer estado anterior a PUBLISHING -> FACT_CHECK_FAILED (executor: sourceStale, M9-D405)
    const prop = await fx.seedProperty(t, tenant);
    const source = await sourceFromProperty(prop.id, tenant, t);
    for (const status of ['DRAFT', 'FACT_CHECKED', 'BRANDED', 'COMPLIANCE_CHECKED', 'PENDING_APPROVAL', 'APPROVED', 'SCHEDULED']) {
      const { item } = await createContentWithProvenance({ type: 'NEW_PROPERTY', title: 'QA-M9 fonte', source, bodyJson: { texto: 'x' } }, tenant, tenant.userId, t);
      await fx.setStatus(t, item.id, status);
      const row = await fx.q(t, 'SELECT i.*, v.id AS version_id FROM marketing.content_items i JOIN marketing.content_versions v ON v.content_item_id = i.id WHERE i.id = :id', { id: item.id });
      await blockStaleItem(row[0], { version: 99 }, tenant, tenant.userId, t);
      assert.equal((await fx.loadItem(t, item.id)).status, 'FACT_CHECK_FAILED', status);
    }
    // (2) APPROVED | SCHEDULED -> PENDING_APPROVAL quando o approved_hash deixa de bater (executor: approval.guard, M9-D404)
    for (const status of ['APPROVED', 'SCHEDULED']) {
      const itemId = await seedItem(t, status);
      const check = await approvalGuard.checkApproval(tenant, tenant.userId, itemId, t);
      assert.equal(check.invalidated, true);
      assert.equal((await fx.loadItem(t, itemId)).status, 'PENDING_APPROVAL');
    }
    // (3) PUBLISHED -> ARCHIVED só quando a atualização chega a PUBLISHED (executor: archiveSuperseded, M9-D405)
    const oldId = await seedItem(t, 'PUBLISHED');
    const [{ id: updateId }] = await fx.q(t,
      `INSERT INTO marketing.content_items (group_id, company_id, type, title, status, updates_content_item_id) VALUES (:g, :c, 'INSTITUTIONAL', 'QA-M9 atualização', 'PUBLISHED', :old) RETURNING id`,
      { g: tenant.groupId, c: tenant.companyId, old: oldId });
    assert.equal((await archiveSupersededOnPublish(updateId, tenant, tenant.userId, t)).archived, true);
    assert.equal((await fx.loadItem(t, oldId)).status, 'ARCHIVED');
    // (4) SCHEDULED -> PUBLISHING e (5) SCHEDULED -> APPROVED (executores: worker M9-D411 e cancelamento M9-D410, via changeStatus)
    for (const to of ['PUBLISHING', 'APPROVED']) {
      const itemId = await seedItem(t, 'SCHEDULED');
      const out = await service.changeStatus({ tenant, actor: tenant.userId, itemId, to }, t);
      assert.deepEqual([out.from, out.status], ['SCHEDULED', to]);
      assert.equal((await fx.loadItem(t, itemId)).status, to);
    }
    // o resto é recusado com 409, sem mudar o status
    for (const [from, to] of [['DRAFT', 'APPROVED'], ['PUBLISHED', 'DRAFT'], ['ARCHIVED', 'DRAFT'], ['PUBLISHING', 'ARCHIVED'], ['FAILED', 'APPROVED'], ['APPROVED', 'DRAFT'], ['PENDING_APPROVAL', 'SCHEDULED']]) {
      const itemId = await seedItem(t, from);
      await assert.rejects(service.changeStatus({ tenant, actor: tenant.userId, itemId, to }, t),
        (e) => e.statusCode === 409 && e.code === 'MKT_CONTENT_INVALID_TRANSITION', `${from} -> ${to}`);
      assert.equal((await fx.loadItem(t, itemId)).status, from);
    }
  });
});
