'use strict';

// M9-D803 — carga inicial/varredura diária das fontes de obras e garantias (calendarBackfillJob), com banco. Banco descartável:
//   node scripts/withDisposableDb.js --port <55000-56999> -- env CI_TENANT_USERS_PASSWORD=... bash -c \
//     "node scripts/seed-ci-two-tenants.js >/dev/null && NODE_ENV=test node --test --test-concurrency=1 test/marco9/governanca/m9d803.backfill.test.js"

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const env = require('../_helpers/m9d803Env');
const projectsService = require('../../../src/features/construction/projects.service');
const stagesService = require('../../../src/features/construction/projectStages.service');
const casesService = require('../../../src/features/construction/maintenanceCases.service');
const guaranteesService = require('../../../src/features/legal/guarantees.service');
const { runBackfill } = require('../../../src/features/core-governance/calendar/sources/backfill.service');
const { projectWarrantySourceId } = require('../../../src/features/core-governance/calendar/sources/ids');
const { hourInSaoPaulo } = require('../../../src/engines/jobs/calendarBackfillJob');
const { isValidDeepLink } = require('../../../src/features/core-governance/calendar/calendar.deeplinks');

let tenant;
const skip = () => (env.DISPOSABLE ? false : env.SKIP_DISPOSABLE);
before(async () => { if (env.DISPOSABLE) tenant = (await env.loadTenants()).A; });
after(async () => { await env.sequelize.close(); });
const run = (fn) => env.withRollbackTenantTransaction(tenant, fn);
const base = () => ({ groupId: tenant.groupId, companyId: tenant.companyId });
const items = (tx, where = '') => env.sequelize.query(
  `SELECT * FROM governance.calendar_items WHERE company_id = :companyId ${where} ORDER BY source_type, source_id`,
  { replacements: { companyId: tenant.companyId }, transaction: tx, type: 'SELECT' }
);

async function seedSources(tx) {
  const project = await projectsService.createProject({ ...base(), name: `Obra M9D803 ${Date.now()}`, responsibleUserId: tenant.userId, endsAtPlanned: '2026-12-15T12:00:00Z' }, tenant.userId, tx);
  const stage = await stagesService.createProjectStage(project.id, { ...base(), name: 'Reboco', endsAt: '2026-11-12T20:00:00Z' }, tenant.userId, tx);
  const contract = await env.leaseContract(tenant, tx);
  const guarantee = await guaranteesService.createGuarantee(contract.id, { guaranteeType: 'DEPOSIT', value: 1000, endsAt: '2026-11-30' }, tenant.userId, tx);
  const prop = await env.property(tenant, tx);
  const kase = await casesService.createMaintenanceCase({ ...base(), propertyId: prop.id, description: 'Infiltração', responsibleUserId: tenant.userId, warrantyDeadlineAt: '2026-11-20T15:30:00Z' }, tenant.userId, tx);
  return { project, stage, contract, guarantee, kase };
}

test('m9d803 backfill é idempotente e traz os registros abertos já existentes', { skip: skip() }, async () => {
  await run(async (tx) => {
    const s = await seedSources(tx);
    const first = await runBackfill(tenant, tx, new Date('2026-10-28T09:00:00Z'));
    assert.equal(first.upserted, 4);
    const rows = await items(tx);
    assert.equal(rows.length, 4);
    const byId = Object.fromEntries(rows.map((r) => [r.source_id, r]));
    assert.equal(byId[s.stage.id].source_type, 'CONSTRUCTION');
    assert.equal(byId[s.stage.id].owner_user_id, tenant.userId);
    assert.equal(byId[s.project.id].due_at.toISOString(), '2026-12-16T02:59:59.000Z');
    assert.equal(byId[s.guarantee.id].due_at.toISOString(), '2026-12-01T02:59:59.000Z');
    assert.equal(byId[s.guarantee.id].severity, 'WARNING');
    assert.equal(byId[s.kase.id].source_kind, 'WARRANTY_CASE');
    for (const row of rows) { assert.ok(isValidDeepLink(row.deep_link), row.deep_link); assert.equal(row.status, 'OPEN'); }

    const second = await runBackfill(tenant, tx, new Date('2026-10-28T09:05:00Z'));
    assert.equal(second.upserted, 4);
    assert.equal((await items(tx)).length, 4, 'reexecução não duplica');
  });
});

test('m9d803 PROJECT_WARRANTY vira DONE após warrantyEndsAt e some o que a origem já não mantém aberto', { skip: skip() }, async () => {
  await run(async (tx) => {
    const s = await seedSources(tx);
    await s.project.update({ status: 'FINAL_INSPECTION' }, { transaction: tx });
    await projectsService.deliverProject(s.project.id, tenant.userId, tx);
    const sourceId = projectWarrantySourceId(s.project.id);

    await runBackfill(tenant, tx, new Date());
    let [warranty] = await items(tx, `AND source_id = '${sourceId}'`);
    assert.equal(warranty.status, 'OPEN');
    assert.equal(warranty.source_kind, 'PROJECT_WARRANTY');
    assert.equal(warranty.deep_link, `/painel/obras/${s.project.id}`);

    // Depois do fim da garantia (a varredura lê só calendar_items): DONE, sem reabrir nas execuções seguintes.
    const later = new Date(warranty.due_at.getTime() + 86400000);
    const closed = await runBackfill(tenant, tx, later);
    assert.equal(closed.warrantyClosed, 1);
    [warranty] = await items(tx, `AND source_id = '${sourceId}'`);
    assert.equal(warranty.status, 'DONE');
    await runBackfill(tenant, tx, later);
    [warranty] = await items(tx, `AND source_id = '${sourceId}'`);
    assert.equal(warranty.status, 'DONE');

    // Garantia liberada e caso fechado deixam de ser origens abertas: o item aberto é cancelado.
    await guaranteesService.updateGuarantee(s.guarantee.id, { status: 'RELEASED' }, tenant.userId, tx);
    await runBackfill(tenant, tx, later);
    const [g] = await items(tx, `AND source_id = '${s.guarantee.id}'`);
    assert.equal(g.status, 'CANCELLED');
    assert.equal(g.cancel_reason, 'SOURCE_NOT_OPEN');
  });
});

test('m9d803 hora da varredura diária é lida em America/Sao_Paulo', () => {
  assert.equal(hourInSaoPaulo(new Date('2026-10-28T09:00:00Z')), 6);
  assert.equal(hourInSaoPaulo(new Date('2026-10-28T02:59:00Z')), 23);
});
