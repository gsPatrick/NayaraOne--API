'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize, getSeedTenant, withRollbackTenantTransaction } = require('./testHelpers');
const projectsService = require('../src/features/construction/projects.service');
const nonconformitiesService = require('../src/features/construction/nonconformities.service');
const filesService = require('../src/features/files/files.service');

let tenant;

before(async () => {
  tenant = await getSeedTenant();
});

after(async () => {
  await sequelize.close();
});

function withTenant(fields) {
  return { groupId: tenant.groupId, companyId: tenant.companyId, ...fields };
}

async function uploadTestFile(transaction, contentBase64, fileName) {
  return filesService.uploadFile(
    withTenant({ fileName, mimeType: 'image/jpeg', contentBase64, category: 'CONSTRUCTION_EVIDENCE' }),
    tenant.userId,
    transaction
  );
}

// M6-59: mesmo arquivo (mesmo checksum) usado como evidência em duas NCs diferentes gera alerta,
// sem bloquear a criação da segunda.
test('M6-59: evidência reutilizada entre duas não conformidades gera alerta, sem bloquear', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const project1 = await projectsService.createProject(withTenant({ name: 'Obra A M6-59', managerUserId: tenant.userId }), tenant.userId, transaction);
    const project2 = await projectsService.createProject(withTenant({ name: 'Obra B M6-59', managerUserId: tenant.userId }), tenant.userId, transaction);

    const sharedContent = Buffer.from('foto-de-rachadura-m6-59').toString('base64');
    const fileA = await uploadTestFile(transaction, sharedContent, 'rachadura-a.jpg');

    const nc1 = await nonconformitiesService.createNonconformity(
      project1.id,
      withTenant({ description: 'Rachadura na fundação', severity: 'HIGH', beforeEvidenceFileIds: [fileA.id] }),
      tenant.userId,
      transaction
    );
    assert.equal(nc1.evidenceReuseFlagged, false, 'primeira NC a usar o arquivo não deve ser flagrada');

    // Reupload do MESMO conteúdo (bytes idênticos, id de arquivo diferente) — o alerta usa
    // checksum de conteúdo, não o id do arquivo.
    const fileB = await uploadTestFile(transaction, sharedContent, 'rachadura-reaproveitada.jpg');
    const nc2 = await nonconformitiesService.createNonconformity(
      project2.id,
      withTenant({ description: 'Rachadura em outra obra (evidência suspeita)', severity: 'HIGH', beforeEvidenceFileIds: [fileB.id] }),
      tenant.userId,
      transaction
    );

    assert.equal(nc2.evidenceReuseFlagged, true, 'segunda NC deve ser flagrada por reuso de evidência');
    assert.equal(nc2.evidenceReuseReferenceId, nc1.id, 'deve apontar para o registro original');
    assert.ok(nc2.evidenceReuseDetails, 'deve carregar detalhes do reuso');
  });
});

test('M6-59: arquivos genuinamente distintos não geram alerta falso-positivo', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const project = await projectsService.createProject(withTenant({ name: 'Obra C M6-59', managerUserId: tenant.userId }), tenant.userId, transaction);

    const fileA = await uploadTestFile(transaction, Buffer.from('foto-real-1').toString('base64'), 'foto1.jpg');
    const nc1 = await nonconformitiesService.createNonconformity(
      project.id,
      withTenant({ description: 'NC 1', severity: 'LOW', beforeEvidenceFileIds: [fileA.id] }),
      tenant.userId,
      transaction
    );
    assert.equal(nc1.evidenceReuseFlagged, false);

    const fileB = await uploadTestFile(transaction, Buffer.from('foto-real-2-diferente').toString('base64'), 'foto2.jpg');
    const nc2 = await nonconformitiesService.createNonconformity(
      project.id,
      withTenant({ description: 'NC 2', severity: 'LOW', beforeEvidenceFileIds: [fileB.id] }),
      tenant.userId,
      transaction
    );
    assert.equal(nc2.evidenceReuseFlagged, false, 'arquivos com conteúdo distinto não devem gerar alerta');
  });
});
