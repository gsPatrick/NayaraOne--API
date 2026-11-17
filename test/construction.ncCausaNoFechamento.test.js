'use strict';

// DI-BI2-8 (resposta de 16/11/2026, item 6) — causa opcional da não conformidade também no FECHAMENTO. Antes só a abertura aceitava `causeCode` e a tela não tinha o
// campo: o indicador de recorrência por causa (M9:794) não tinha como receber o dado. Fechar com causa grava a causa (normalizada); sem causa continua permitido e
// não apaga a da abertura. Transação com rollback.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix } = require('./testHelpers');
const { evidenceIds } = require('./constructionEvidenceFixture');
const projectsService = require('../src/features/construction/projects.service');
const nonconformitiesService = require('../src/features/construction/nonconformities.service');
const { normalizeCauseCode } = require('../src/features/construction/nonconformityCause');

let tenant;
before(async () => { tenant = await getSeedTenant(); });
after(async () => { await sequelize.close(); });

async function openNc(transaction, extra = {}) {
  const project = await projectsService.createProject({ groupId: tenant.groupId, companyId: tenant.companyId, name: `NC causa ${uniqueSuffix()}` }, tenant.userId, transaction);
  return nonconformitiesService.createNonconformity(project.id, {
    groupId: tenant.groupId, companyId: tenant.companyId, severity: 'MEDIUM', description: 'Rejunte solto no piso da cozinha.', responsibleUserId: tenant.userId,
    beforeEvidenceFileIds: await evidenceIds(tenant, transaction), ...extra,
  }, tenant.userId, transaction);
}

const close = async (nc, transaction, extra = {}) => nonconformitiesService.closeNonconformity(nc.id, { afterEvidenceFileIds: await evidenceIds(tenant, transaction), ...extra }, tenant.userId, transaction);

test('DI-BI2-8 normalização única: aparada, maiúsculas, até 64; vazia vira null', () => {
  assert.equal(normalizeCauseCode('  infiltracao '), 'INFILTRACAO');
  assert.equal(normalizeCauseCode('x'.repeat(80)).length, 64);
  assert.equal(normalizeCauseCode('   '), null);
  assert.equal(normalizeCauseCode(undefined), null);
});

test('DI-BI2-8 fechar com causa grava a causa na não conformidade (antes ficava sem causa)', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const nc = await openNc(transaction);
    assert.equal(nc.causeCode, null);
    const closed = await close(nc, transaction, { causeCode: ' mao de obra ' });
    assert.deepEqual([closed.status, closed.causeCode], ['CLOSED', 'MAO DE OBRA']);
    const [[row]] = await sequelize.query('SELECT cause_code FROM construction.nonconformities WHERE id = :id', { replacements: { id: nc.id }, transaction });
    assert.equal(row.cause_code, 'MAO DE OBRA');
  });
});

test('DI-BI2-8 fechar sem causa continua permitido e não apaga a causa da abertura; causa nova no fechamento corrige', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const semCausa = await close(await openNc(transaction), transaction);
    assert.deepEqual([semCausa.status, semCausa.causeCode], ['CLOSED', null]);
    const comCausa = await close(await openNc(transaction, { causeCode: 'material' }), transaction, { causeCode: '  ' });
    assert.deepEqual([comCausa.status, comCausa.causeCode], ['CLOSED', 'MATERIAL'], 'vazio no fechamento mantém a causa');
    const corrigida = await close(await openNc(transaction, { causeCode: 'material' }), transaction, { causeCode: 'projeto' });
    assert.equal(corrigida.causeCode, 'PROJETO');
  });
});
