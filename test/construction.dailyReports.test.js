'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix } = require('./testHelpers');
const projectsService = require('../src/features/construction/projects.service');
const projectStagesService = require('../src/features/construction/projectStages.service');
const stageDependenciesService = require('../src/features/construction/stageDependencies.service');
const dailyReportsService = require('../src/features/construction/dailyReports.service');
const peopleService = require('../src/features/people/people.service');
const { DailyReport } = require('../src/models');
const AppError = require('../src/utils/AppError');

let tenant;

before(async () => {
  tenant = await getSeedTenant();
});

after(async () => {
  await sequelize.close();
});

function withTenant(overrides) {
  return { groupId: tenant.groupId, companyId: tenant.companyId, ...overrides };
}

async function createTestProject(transaction, suffix) {
  return projectsService.createProject(
    withTenant({ name: `Obra HOM-QA ${suffix}` }),
    tenant.userId,
    transaction
  );
}

async function createTestStage(projectId, transaction, name) {
  return projectStagesService.createProjectStage(projectId, withTenant({ name }), tenant.userId, transaction);
}

// M6-56 — dependência cíclica entre etapas tem que ser bloqueada na criação, mesmo quando o
// ciclo só se fecha de forma indireta/transitiva (A->B->C->A), não só na aresta direta A->A.
test('M6-56: dependência cíclica entre etapas bloqueia (direta e transitiva)', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const suffix = uniqueSuffix();
    const project = await createTestProject(t, suffix);
    const stageA = await createTestStage(project.id, t, `Fundação ${suffix}`);
    const stageB = await createTestStage(project.id, t, `Estrutura ${suffix}`);
    const stageC = await createTestStage(project.id, t, `Alvenaria ${suffix}`);

    // A depende de si mesma: bloqueado antes mesmo de checar ciclo (auto-referência).
    await assert.rejects(
      () => stageDependenciesService.createStageDependency(stageA.id, withTenant({ dependsOnStageId: stageA.id }), tenant.userId, t),
      (err) => err instanceof AppError && err.code === 'STAGE_DEPENDENCY_SELF_REFERENCE'
    );

    // Cadeia válida sem ciclo: B depende de A, C depende de B.
    await stageDependenciesService.createStageDependency(stageB.id, withTenant({ dependsOnStageId: stageA.id }), tenant.userId, t);
    await stageDependenciesService.createStageDependency(stageC.id, withTenant({ dependsOnStageId: stageB.id }), tenant.userId, t);

    // Fechar o ciclo: A passaria a depender de C, que depende de B, que depende de A. Bloqueado.
    await assert.rejects(
      () => stageDependenciesService.createStageDependency(stageA.id, withTenant({ dependsOnStageId: stageC.id }), tenant.userId, t),
      (err) => err instanceof AppError && err.code === 'STAGE_DEPENDENCY_CYCLE'
    );

    const dependenciesOfB = await stageDependenciesService.listStageDependencies(stageB.id, t);
    assert.equal(dependenciesOfB.length, 1);
    assert.equal(dependenciesOfB[0].dependsOnStageId, stageA.id);
  });
});

// M6-58 — RDO duplicado na mesma chave lógica (project_id + report_date + shift_code) bloqueia;
// turnos diferentes no mesmo dia não bloqueiam (M6-07).
test('M6-58: diário duplicado no mesmo turno bloqueia; turnos diferentes não bloqueiam', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const suffix = uniqueSuffix();
    const project = await createTestProject(t, suffix);
    const reportDate = '2026-09-15';

    const morning = await dailyReportsService.createDailyReport(
      project.id,
      withTenant({ reportDate, shiftCode: 'MANHA', workforceCount: 5 }),
      tenant.userId,
      t
    );
    assert.equal(morning.shiftCode, 'MANHA');

    // Mesmo turno, mesma data, mesma obra: idempotência de criação bloqueia duplicata.
    await assert.rejects(
      () =>
        dailyReportsService.createDailyReport(
          project.id,
          withTenant({ reportDate, shiftCode: 'MANHA', workforceCount: 8 }),
          tenant.userId,
          t
        ),
      (err) => err instanceof AppError && err.code === 'DAILY_REPORT_DUPLICATE'
    );

    // Turno diferente na mesma data/obra: permitido (M6-07).
    const afternoon = await dailyReportsService.createDailyReport(
      project.id,
      withTenant({ reportDate, shiftCode: 'TARDE', workforceCount: 3 }),
      tenant.userId,
      t
    );
    assert.equal(afternoon.shiftCode, 'TARDE');
    assert.notEqual(afternoon.id, morning.id);
  });
});

// M6-20/M6-83 — correção de um RDO já criado NUNCA apaga o registro original: gera uma nova
// linha (revisão) apontando para a anterior via `supersedesId`. O original continua no banco,
// legível, intacto.
test('M6-20: correção de RDO é append-only — original permanece no banco após "correção"', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const suffix = uniqueSuffix();
    const project = await createTestProject(t, suffix);
    const worker = await peopleService.createPerson(
      withTenant({ personType: 'PF', legalName: `Pedreiro HOM-QA ${suffix}` }),
      tenant.userId,
      t
    );

    const original = await dailyReportsService.createDailyReport(
      project.id,
      withTenant({
        reportDate: '2026-09-16',
        shiftCode: 'MANHA',
        weather: 'ENSOLARADO',
        workforceCount: 4,
        occurrences: 'Nenhuma ocorrência.',
        workers: [{ personId: worker.id, role: 'Pedreiro' }],
        materials: [{ materialDescription: 'Cimento CP-II', quantity: 10, unit: 'SC' }],
      }),
      tenant.userId,
      t
    );

    const revision = await dailyReportsService.correctDailyReport(
      original.id,
      { occurrences: 'Correção: houve atraso na entrega de material.', workforceCount: 6 },
      tenant.userId,
      t
    );

    // A revisão é uma linha NOVA, distinta do original, apontando pra ele.
    assert.notEqual(revision.id, original.id);
    assert.equal(revision.supersedesId, original.id);
    assert.equal(revision.occurrences, 'Correção: houve atraso na entrega de material.');
    assert.equal(revision.workforceCount, 6);

    // O registro original CONTINUA no banco, sem alteração (append-only de verdade — não é só
    // "não jogamos fora na aplicação", é uma linha física ainda lá).
    const originalStillInDb = await DailyReport.findByPk(original.id, { transaction: t });
    assert.ok(originalStillInDb, 'RDO original precisa continuar existindo no banco após a correção.');
    assert.equal(originalStillInDb.occurrences, 'Nenhuma ocorrência.');
    assert.equal(originalStillInDb.workforceCount, 4);
    assert.equal(originalStillInDb.supersedesId, null);

    // Buscar a "versão atual" a partir de qualquer ponto da cadeia (inclusive do id original)
    // deve sempre devolver a revisão mais recente.
    const current = await dailyReportsService.getCurrentDailyReport(original.id, t);
    assert.equal(current.id, revision.id);
  });
});

// M6-94 — captura offline: reenviar a mesma `idempotencyKey` (simulando o app sincronizando de
// novo um RDO que já tinha ido pro servidor) não cria um segundo registro.
test('M6-94: idempotencyKey de captura offline evita duplicar RDO ao ressincronizar', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const suffix = uniqueSuffix();
    const project = await createTestProject(t, suffix);
    const idempotencyKey = `offline-${suffix}`;

    const first = await dailyReportsService.createDailyReport(
      project.id,
      withTenant({ reportDate: '2026-09-17', shiftCode: 'NOITE', clientLocalId: `local-${suffix}`, idempotencyKey }),
      tenant.userId,
      t
    );

    const resynced = await dailyReportsService.createDailyReport(
      project.id,
      withTenant({ reportDate: '2026-09-17', shiftCode: 'NOITE', clientLocalId: `local-${suffix}`, idempotencyKey }),
      tenant.userId,
      t
    );

    assert.equal(resynced.id, first.id);
  });
});

// Achado numa rodada de verificação de integrações (30/09/2026): a fonte exige que o diário
// registre "fotos" — campo estava inteiramente ausente. Confirma que o RDO aceita e preserva
// evidência fotográfica, inclusive através de uma correção (append-only).
test('RDO aceita e preserva evidenceFileIds, inclusive numa correção (append-only)', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const suffix = uniqueSuffix();
    const project = await createTestProject(t, suffix);
    const fakeFileId1 = '11111111-1111-1111-1111-111111111111';
    const fakeFileId2 = '22222222-2222-2222-2222-222222222222';

    const created = await dailyReportsService.createDailyReport(
      project.id,
      withTenant({ reportDate: '2026-09-18', evidenceFileIds: [fakeFileId1] }),
      tenant.userId,
      t
    );
    assert.deepEqual(created.evidenceFileIds, [fakeFileId1]);

    const corrected = await dailyReportsService.correctDailyReport(
      created.id,
      { evidenceFileIds: [fakeFileId1, fakeFileId2] },
      tenant.userId,
      t
    );
    assert.deepEqual(corrected.evidenceFileIds, [fakeFileId1, fakeFileId2]);

    const originalReloaded = await DailyReport.findByPk(created.id, { transaction: t });
    assert.deepEqual(originalReloaded.evidenceFileIds, [fakeFileId1], 'registro original não deve ser alterado (append-only)');
  });
});

// Achado numa rodada de verificação de integrações (30/09/2026): a fonte exige "documentação
// correspondente" vinculada ao prestador do dia — campo estava inteiramente ausente em
// DailyWorker. Confirma que o RDO aceita e preserva documentFileIds por trabalhador.
test('RDO aceita e preserva documentFileIds por trabalhador (documentação do prestador)', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const suffix = uniqueSuffix();
    const project = await createTestProject(t, suffix);
    const worker = await peopleService.createPerson(
      withTenant({ personType: 'PF', legalName: `Prestador HOM-QA ${suffix}` }),
      tenant.userId,
      t
    );
    const fakeDocId = '33333333-3333-3333-3333-333333333333';

    const created = await dailyReportsService.createDailyReport(
      project.id,
      withTenant({
        reportDate: '2026-09-19',
        workers: [{ personId: worker.id, role: 'Eletricista', documentFileIds: [fakeDocId] }],
      }),
      tenant.userId,
      t
    );

    const { DailyWorker } = require('../src/models');
    const workers = await DailyWorker.findAll({ where: { dailyReportId: created.id }, transaction: t });
    assert.equal(workers.length, 1);
    assert.deepEqual(workers[0].documentFileIds, [fakeDocId]);
  });
});
