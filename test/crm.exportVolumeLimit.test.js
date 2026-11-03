'use strict';

// PENDÊNCIA REAL FECHADA (Marco 3, CRM-TS-013 / item 14 do Caderno, seção 18 "Antifraude e
// segurança": "Exportar base de clientes — Permissão, MFA, volume limit, audit"). Permissão e
// auditoria já existiam (M3-21, test/marco3.crm.test.js); MFA e limite de volume foram
// adicionados nesta rodada em opportunitiesExport.service.js. Este arquivo cobre
// especificamente o limite de volume (o MFA já está coberto em marco3.crm.test.js).

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { authenticator } = require('otplib');

const { sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix } = require('./testHelpers');
const { Person, Opportunity } = require('../src/models');
const exportService = require('../src/features/crm/opportunitiesExport.service');
const mfaService = require('../src/features/users/mfa.service');
const AppError = require('../src/utils/AppError');

after(async () => {
  await sequelize.close();
});

async function setUpMfa(tenant, transaction) {
  // Determinismo (19/10/2026): o usuário semente do banco compartilhado já tem MFA configurado
  // (commitado em 14/10) e setupMfa recusa reconfigurar. Este arquivo testa o LIMITE DE VOLUME (o
  // fluxo de MFA está em marco3.crm/mfa.test): se não houver credencial, configura pelo service;
  // havendo, só registra um step-up recente — tudo dentro da transação de rollback.
  const { MfaCredential, MfaStepUp } = require('../src/models');
  const existing = await MfaCredential.findOne({ where: { userId: tenant.userId }, transaction });
  if (!existing) {
    const { otpauthUri } = await mfaService.setupMfa(tenant.userId, tenant, transaction);
    const secret = /[?&]secret=([^&]+)/.exec(otpauthUri)[1];
    await mfaService.confirmMfa(tenant.userId, authenticator.generate(secret), tenant, transaction);
    await mfaService.verifyMfa(tenant.userId, authenticator.generate(secret), tenant, transaction);
    return;
  }
  assert.ok(existing.enabled, 'credencial MFA do usuário semente deveria estar habilitada');
  const stepUp = { verifiedAt: new Date(), expiresAt: new Date(Date.now() + 10 * 60 * 1000) };
  const [updated] = await MfaStepUp.update(stepUp, { where: { userId: tenant.userId }, transaction });
  if (!updated) {
    await MfaStepUp.create({ groupId: tenant.groupId, companyId: tenant.companyId, userId: tenant.userId, ...stepUp }, { transaction });
  }
}

test('CRM-TS-013: exportação acima do limite de volume é recusada, não truncada', async () => {
  const tenant = await getSeedTenant();
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const suffix = uniqueSuffix();
    const person = await Person.create(
      {
        groupId: tenant.groupId,
        companyId: tenant.companyId,
        personType: 'PF',
        legalName: `Lead volume ${suffix}`,
      },
      { transaction }
    );

    // bulkCreate direto (sem passar pelo service de criação) — o teste quer só volume, não
    // revalidar as invariantes de criação de oportunidade (já cobertas em outros testes).
    const rows = Array.from({ length: exportService.MAX_EXPORT_RECORDS + 1 }, () => ({
      groupId: tenant.groupId,
      companyId: tenant.companyId,
      personId: person.id,
      stage: 'NEW',
      createdBy: tenant.userId,
      updatedBy: tenant.userId,
    }));
    await Opportunity.bulkCreate(rows, { transaction });

    await setUpMfa(tenant, transaction);

    await assert.rejects(
      () =>
        exportService.exportOpportunities(
          {
            groupId: tenant.groupId,
            companyId: tenant.companyId,
            actorUserId: tenant.userId,
            actorPermissions: ['crm:opportunities:read', 'crm:opportunities:export'],
            format: 'csv',
            filters: { personId: person.id },
          },
          transaction
        ),
      (err) => {
        assert.ok(err instanceof AppError);
        assert.equal(err.statusCode, 400);
        assert.equal(err.code, 'EXPORT_VOLUME_LIMIT_EXCEEDED');
        return true;
      }
    );
  });
});

test('CRM-TS-013: exportação dentro do limite de volume funciona normalmente', async () => {
  const tenant = await getSeedTenant();
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const suffix = uniqueSuffix();
    const person = await Person.create(
      {
        groupId: tenant.groupId,
        companyId: tenant.companyId,
        personType: 'PF',
        legalName: `Lead volume ok ${suffix}`,
      },
      { transaction }
    );
    await Opportunity.create(
      {
        groupId: tenant.groupId,
        companyId: tenant.companyId,
        personId: person.id,
        stage: 'NEW',
        createdBy: tenant.userId,
        updatedBy: tenant.userId,
      },
      { transaction }
    );

    await setUpMfa(tenant, transaction);

    const result = await exportService.exportOpportunities(
      {
        groupId: tenant.groupId,
        companyId: tenant.companyId,
        actorUserId: tenant.userId,
        actorPermissions: ['crm:opportunities:read', 'crm:opportunities:export'],
        format: 'csv',
        filters: { personId: person.id },
      },
      transaction
    );

    assert.equal(result.recordCount, 1);
  });
});
