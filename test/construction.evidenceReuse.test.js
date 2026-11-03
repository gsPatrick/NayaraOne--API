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
      withTenant({ description: 'Rachadura na fundação', severity: 'HIGH', responsibleUserId: tenant.userId, beforeEvidenceFileIds: [fileA.id] }),
      tenant.userId,
      transaction
    );
    assert.equal(nc1.evidenceReuseFlagged, false, 'primeira NC a usar o arquivo não deve ser flagrada');

    // Reupload do MESMO conteúdo (bytes idênticos, id de arquivo diferente) — o alerta usa
    // checksum de conteúdo, não o id do arquivo.
    const fileB = await uploadTestFile(transaction, sharedContent, 'rachadura-reaproveitada.jpg');
    const nc2 = await nonconformitiesService.createNonconformity(
      project2.id,
      withTenant({ description: 'Rachadura em outra obra (evidência suspeita)', severity: 'HIGH', responsibleUserId: tenant.userId, beforeEvidenceFileIds: [fileB.id] }),
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
      withTenant({ description: 'NC 1', severity: 'LOW', responsibleUserId: tenant.userId, beforeEvidenceFileIds: [fileA.id] }),
      tenant.userId,
      transaction
    );
    assert.equal(nc1.evidenceReuseFlagged, false);

    const fileB = await uploadTestFile(transaction, Buffer.from('foto-real-2-diferente').toString('base64'), 'foto2.jpg');
    const nc2 = await nonconformitiesService.createNonconformity(
      project.id,
      withTenant({ description: 'NC 2', severity: 'LOW', responsibleUserId: tenant.userId, beforeEvidenceFileIds: [fileB.id] }),
      tenant.userId,
      transaction
    );
    assert.equal(nc2.evidenceReuseFlagged, false, 'arquivos com conteúdo distinto não devem gerar alerta');
  });
});

// GAP REAL CORRIGIDO ("ciclos até secar", Ciclo 9, Frente A, 09/10/2026): detectEvidenceReuse
// exclui o próprio registro da busca (pra não acusar reuso contra ele mesmo), mas isso também
// deixava sem nenhuma checagem o caso de fechar a NC usando a MESMA foto como prova do "antes"
// e do "depois" — persistindo um estado contraditório sem nenhum alerta.
test('M6-59/GAP: fechar a NC reaproveitando a MESMA evidência do "antes" como prova do "depois" gera alerta', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const project = await projectsService.createProject(withTenant({ name: 'Obra D M6-59 self-reuse', managerUserId: tenant.userId }), tenant.userId, transaction);

    const sharedContent = Buffer.from('foto-unica-antes-e-depois-m6-59').toString('base64');
    const fileBefore = await uploadTestFile(transaction, sharedContent, 'antes.jpg');

    const nc = await nonconformitiesService.createNonconformity(
      project.id,
      withTenant({ description: 'Infiltração na parede', severity: 'MEDIUM', responsibleUserId: tenant.userId, beforeEvidenceFileIds: [fileBefore.id] }),
      tenant.userId,
      transaction
    );
    assert.equal(nc.evidenceReuseFlagged, false);

    // Reupload do MESMO conteúdo (bytes idênticos) usado agora como prova do "depois" — a
    // "prova de que foi corrigido" é literalmente a mesma foto da constatação original.
    const fileAfterSameContent = await uploadTestFile(transaction, sharedContent, 'depois-mesma-foto.jpg');
    const closed = await nonconformitiesService.closeNonconformity(
      nc.id,
      { afterEvidenceFileIds: [fileAfterSameContent.id] },
      tenant.userId,
      transaction
    );

    assert.equal(closed.status, 'CLOSED', 'fechamento continua permitido — a regra é alertar, não bloquear');
    assert.equal(closed.evidenceReuseFlagged, true, 'reaproveitar a evidência do "antes" como "depois" precisa gerar o alerta de reuso');
    assert.ok(closed.evidenceReuseDetails, 'deve carregar detalhes do reuso');
  });
});
