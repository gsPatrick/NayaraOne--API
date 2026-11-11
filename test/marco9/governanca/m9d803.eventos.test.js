'use strict';

// M9-D803 — eventos de origem que alimentam o Calendário (obras e garantias), com banco. Banco descartável:
//   node scripts/withDisposableDb.js --port <55000-56999> -- env CI_TENANT_USERS_PASSWORD=... bash -c \
//     "node scripts/seed-ci-two-tenants.js >/dev/null && NODE_ENV=test node --test --test-concurrency=1 test/marco9/governanca/m9d803.eventos.test.js"

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const env = require('../_helpers/m9d803Env');
const projectsService = require('../../../src/features/construction/projects.service');
const stagesService = require('../../../src/features/construction/projectStages.service');
const casesService = require('../../../src/features/construction/maintenanceCases.service');
const guaranteesService = require('../../../src/modules/legal/leasing/guarantee.service');
const calendarEvents = require('../../../src/features/construction/constructionCalendarEvents.service');
const { upsertSetting } = require('../../../src/features/settings/settings.service');
const { dateKeyInZone, addMonthsToDateKey } = require('../../../src/features/core-governance/calendar/sources/time');
const { warrantyCaseCalendarFields } = calendarEvents;

let tenant;
const skip = () => (env.DISPOSABLE ? false : env.SKIP_DISPOSABLE);

before(async () => { if (env.DISPOSABLE) tenant = (await env.loadTenants()).A; });
after(async () => { await env.sequelize.close(); });

const run = (fn) => env.withRollbackTenantTransaction(tenant, fn);
const newProject = (tx, extra = {}) => projectsService.createProject({ groupId: tenant.groupId, companyId: tenant.companyId, name: `Obra M9D803 ${Date.now()}`, responsibleUserId: tenant.userId, ...extra }, tenant.userId, tx);

test('m9d803 project.stage.updated é publicado uma vez por mudança', { skip: skip() }, async () => {
  await run(async (tx) => {
    const project = await newProject(tx);
    const stage = await stagesService.createProjectStage(project.id, { groupId: tenant.groupId, companyId: tenant.companyId, name: 'Reboco', endsAt: '2026-11-12T20:00:00Z' }, tenant.userId, tx);
    const list = () => env.events(stage.id, 'project.stage.updated', tx);
    let rows = await list();
    assert.equal(rows.length, 1, 'criação com prazo publica');
    assert.deepEqual(
      Object.keys(rows[0].payloadJson).sort(),
      ['endsAt', 'projectId', 'projectName', 'responsibleUserId', 'stageId', 'stageName', 'status'].sort()
    );
    assert.equal(rows[0].payloadJson.responsibleUserId, tenant.userId);
    assert.equal(rows[0].idempotencyKey, `project.stage.updated:${stage.id}:${stage.lockVersion}`);

    await stagesService.updateProjectStage(stage.id, { name: 'Reboco externo' }, tenant.userId, tx);
    assert.equal((await list()).length, 1, 'renomear não muda prazo nem status: nenhum evento');

    await stagesService.updateProjectStage(stage.id, { endsAt: '2026-11-20T20:00:00Z' }, tenant.userId, tx);
    rows = await list();
    assert.equal(rows.length, 2, 'mudar o prazo publica uma vez');

    await stagesService.updateProjectStage(stage.id, { endsAt: '2026-11-20T20:00:00Z' }, tenant.userId, tx);
    assert.equal((await list()).length, 2, 'repetir o mesmo prazo não publica de novo');

    // Republicar a mesma versão da etapa (replay) é no-op da outbox: a chave inclui o lock_version.
    await calendarEvents.publishProjectStageUpdated(await stagesService.getProjectStage(stage.id, tx), tx);
    assert.equal((await list()).length, 2);

    await stagesService.updateProjectStage(stage.id, { status: 'IN_PROGRESS', stageCode: 'REB', plannedCost: 100, startsAt: '2026-11-01T12:00:00Z' }, tenant.userId, tx);
    await stagesService.updateProjectStage(stage.id, { status: 'DONE' }, tenant.userId, tx);
    rows = await list();
    assert.equal(rows.length, 4, 'IN_PROGRESS e DONE publicam um evento cada');
    assert.equal(rows[3].payloadJson.status, 'DONE');
    assert.equal((await env.events(stage.id, 'project.stage.completed', tx)).length, 1);
  });
});

test('m9d803 etapa sem prazo e mudança de responsável da obra reemitem a etapa', { skip: skip() }, async () => {
  await run(async (tx) => {
    const project = await newProject(tx, { endsAtPlanned: '2026-12-15T03:00:00Z' });
    const noDate = await stagesService.createProjectStage(project.id, { groupId: tenant.groupId, companyId: tenant.companyId, name: 'Sem data' }, tenant.userId, tx);
    assert.equal((await env.events(noDate.id, 'project.stage.updated', tx))[0].payloadJson.endsAt, null);
    const stage = await stagesService.createProjectStage(project.id, { groupId: tenant.groupId, companyId: tenant.companyId, name: 'Com data', endsAt: '2026-11-12T20:00:00Z' }, tenant.userId, tx);
    const created = (await env.events(project.id, 'project.created', tx))[0];
    assert.equal(created.payloadJson.responsibleUserId, tenant.userId);
    assert.ok(created.payloadJson.endsAtPlanned, 'project.created leva o prazo final');

    const [other] = await env.sequelize.query('SELECT id FROM core.users WHERE id <> :id LIMIT 1', { replacements: { id: tenant.userId }, transaction: tx, type: 'SELECT' });
    await projectsService.updateProject(project.id, { responsibleUserId: other ? other.id : null }, tenant.userId, tx);
    assert.equal((await env.events(project.id, 'project.schedule.updated', tx)).length, 1);
    const rows = await env.events(stage.id, 'project.stage.updated', tx);
    assert.equal(rows.length, 2, 'trocar o responsável da obra reemite a etapa aberta');
    assert.equal(rows[1].payloadJson.responsibleUserId, other ? other.id : null);
    await projectsService.updateProject(project.id, { name: 'Outro nome' }, tenant.userId, tx);
    assert.equal((await env.events(project.id, 'project.schedule.updated', tx)).length, 1, 'sem mudança de prazo/responsável: nada');
  });
});

test('m9d803 legal.guarantee.updated e legal.guarantee.ended são publicados e idempotentes', { skip: skip() }, async () => {
  await run(async (tx) => {
    const contract = await env.leaseContract(tenant, tx);
    const g = await guaranteesService.createGuarantee(contract.id, await require('../../m5fech.locacao.helpers').completeInsurance(tenant, tx, { value: 1000, status: 'ACTIVE', startsAt: '2026-01-01', endsAt: '2026-11-30', renewalDueAt: '2026-11-01' }), tenant.userId, tx);
    const created = (await env.events(g.id, 'legal.guarantee.created', tx))[0];
    assert.equal(created.payloadJson.endsAt, '2026-11-30');
    assert.equal(created.payloadJson.status, 'ACTIVE');
    assert.equal(created.payloadJson.ownerUserId, tenant.userId);

    const updated = await guaranteesService.updateGuarantee(g.id, { endsAt: '2026-12-31' }, tenant.userId, tx);
    let rows = await env.events(g.id, 'legal.guarantee.updated', tx);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].idempotencyKey, `legal.guarantee.updated:${g.id}:${updated.lockVersion}`);
    assert.equal(rows[0].payloadJson.endsAt, '2026-12-31');
    await guaranteesService.updateGuarantee(g.id, { endsAt: '2026-12-31' }, tenant.userId, tx);
    assert.equal((await env.events(g.id, 'legal.guarantee.updated', tx)).length, 1, 'mesmo valor: nenhum evento');

    await guaranteesService.updateGuarantee(g.id, { status: 'RELEASED' }, tenant.userId, tx);
    rows = await env.events(g.id, 'legal.guarantee.ended', tx);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].idempotencyKey, `legal.guarantee.ended:${g.id}`);
    assert.equal(rows[0].payloadJson.reason, 'RELEASED');

    const g2 = await guaranteesService.createGuarantee(contract.id, { guaranteeType: 'DEPOSIT', value: 1000, endsAt: '2027-01-31' }, tenant.userId, tx);
    await guaranteesService.deleteGuarantee(g2.id, tenant.userId, tx);
    assert.equal((await env.events(g2.id, 'legal.guarantee.ended', tx))[0].payloadJson.reason, 'DELETED');

    const g3 = await guaranteesService.createGuarantee(contract.id, { guaranteeType: 'DEPOSIT', value: 1000, endsAt: '2027-02-28' }, tenant.userId, tx);
    const { newGuarantee } = await guaranteesService.replaceGuarantee(g3.id, { guaranteeType: 'INSURANCE', value: 2000, endsAt: '2028-02-28' }, tenant.userId, tx);
    const replaced = (await env.events(g3.id, 'legal.guarantee.replaced', tx))[0];
    assert.equal(replaced.payloadJson.newGuarantee.id, newGuarantee.id);
    assert.equal(replaced.payloadJson.newGuarantee.endsAt, '2028-02-28');
    assert.equal((await env.events(g3.id, 'legal.guarantee.ended', tx)).length, 0, 'substituição não publica ended: o replaced fecha');
  });
});

test('m9d803 project.warranty_started leva warrantyEndsAt pelo prazo configurado e o caso em garantia leva prazo e responsável', { skip: skip() }, async () => {
  await run(async (tx) => {
    const today = dateKeyInZone(new Date());
    const project = await newProject(tx);
    await project.update({ status: 'FINAL_INSPECTION' }, { transaction: tx });
    await projectsService.deliverProject(project.id, tenant.userId, tx);
    const started = (await env.events(project.id, 'project.warranty_started', tx))[0];
    assert.equal(started.payloadJson.warrantyEndsAt, addMonthsToDateKey(today, 60), 'padrão: 60 meses');
    assert.equal(started.payloadJson.responsibleUserId, tenant.userId);

    await upsertSetting('governanca.calendario.garantia_obra_meses', 12, tenant, tenant.userId, tx);
    assert.equal(await calendarEvents.computeProjectWarrantyEndsAt(project, tx), addMonthsToDateKey(today, 12), 'o administrador muda o prazo');

    const prop = await env.property(tenant, tx);
    const kase = await casesService.createMaintenanceCase({
      groupId: tenant.groupId, companyId: tenant.companyId, propertyId: prop.id, description: 'Infiltração', responsibleUserId: tenant.userId, warrantyDeadlineAt: '2026-11-20T15:30:00Z',
    }, tenant.userId, tx);
    const opened = (await env.events(kase.id, 'warranty.case.opened', tx))[0];
    assert.equal(opened.payloadJson.warrantyDeadlineAt, '2026-11-20T15:30:00.000Z');
    assert.equal(opened.payloadJson.responsibleUserId, tenant.userId);
    assert.deepEqual(Object.keys(warrantyCaseCalendarFields(kase)).sort(), ['description', 'responsibleUserId', 'warrantyDeadlineAt']);
  });
});
