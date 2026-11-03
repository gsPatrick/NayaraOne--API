'use strict';

// PENDÊNCIA REAL FECHADA (Marco 3, CRM-TS-012 / item 17 do Caderno, seção 18 "Antifraude e
// segurança": "Corretor visualizar carteira alheia — Escopo conforme política de equipe").
// Diferente do isolamento cross-company já provado em marco3.crossCompanyIsolation.test.js
// (RLS por empresa), este teste cobre o escopo DENTRO da mesma empresa: um corretor só deve
// ver as oportunidades das quais é responsável (ownerUserId), a menos que tenha a permissão
// de gestor `crm:opportunities:read:all`.

const { test, after } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix } = require('./testHelpers');
const peopleService = require('../src/features/people/people.service');
const opportunityService = require('../src/features/crm/opportunity.service');
const { User } = require('../src/models');

after(async () => {
  await sequelize.close();
});

// owner_user_id tem FK para core.users — "outro corretor" precisa ser um usuário real da
// mesma empresa, não um UUID fictício.
async function createSecondBroker(tenant, transaction) {
  const suffix = uniqueSuffix();
  const user = await User.create(
    {
      groupId: tenant.groupId,
      companyId: tenant.companyId,
      name: `Corretor B ${suffix}`,
      email: `corretor-b-${suffix}@teste.nayaraone.dev`,
      passwordHash: 'x', // não autentica neste teste, só precisa satisfazer NOT NULL
      mfaEnabled: false,
      status: 'ACTIVE',
    },
    { transaction }
  );
  return user.id;
}

async function createOpportunityFor(tenant, ownerUserId, transaction) {
  const person = await peopleService.createPerson(
    { groupId: tenant.groupId, companyId: tenant.companyId, personType: 'PF', legalName: `Lead ${uniqueSuffix()}` },
    tenant.userId,
    transaction
  );
  return opportunityService.createOpportunity(
    {
      groupId: tenant.groupId,
      companyId: tenant.companyId,
      personId: person.id,
      ownerUserId,
      nextAction: 'Ligar para o lead',
      nextActionDueAt: new Date(Date.now() + 86400000).toISOString(),
    },
    tenant.userId,
    transaction
  );
}

test('CRM-TS-012: corretor com escopo OWN só vê as oportunidades das quais é o responsável', async () => {
  const tenant = await getSeedTenant();
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const corretorA = tenant.userId;
    const corretorB = await createSecondBroker(tenant, transaction);

    const oppA = await createOpportunityFor(tenant, corretorA, transaction);
    const oppB = await createOpportunityFor(tenant, corretorB, transaction);

    const scoped = await opportunityService.listOpportunities(transaction, {
      ownerScope: { mode: 'OWN', userId: corretorA },
    });

    const ids = scoped.map((o) => o.id);
    assert.ok(ids.includes(oppA.id), 'corretor deve ver a própria oportunidade');
    assert.ok(!ids.includes(oppB.id), 'corretor NÃO deve ver a oportunidade de outro corretor (CRM-TS-012)');
  });
});

test('CRM-TS-012: gestor com escopo ALL vê oportunidades de todos os corretores', async () => {
  const tenant = await getSeedTenant();
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const corretorA = tenant.userId;
    const corretorB = await createSecondBroker(tenant, transaction);

    const oppA = await createOpportunityFor(tenant, corretorA, transaction);
    const oppB = await createOpportunityFor(tenant, corretorB, transaction);

    const all = await opportunityService.listOpportunities(transaction, { ownerScope: { mode: 'ALL' } });
    const ids = all.map((o) => o.id);
    assert.ok(ids.includes(oppA.id));
    assert.ok(ids.includes(oppB.id));
  });
});

test('CRM-TS-012: sem ownerScope (fallback), comportamento é ALL — sem regressão para papéis ainda não migrados', async () => {
  const tenant = await getSeedTenant();
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const corretorA = tenant.userId;
    const corretorB = await createSecondBroker(tenant, transaction);

    const oppA = await createOpportunityFor(tenant, corretorA, transaction);
    const oppB = await createOpportunityFor(tenant, corretorB, transaction);

    const noScope = await opportunityService.listOpportunities(transaction, {});
    const ids = noScope.map((o) => o.id);
    assert.ok(ids.includes(oppA.id));
    assert.ok(ids.includes(oppB.id));
  });
});

test('CRM-TS-012: catálogo de permissões tem os 2 códigos de escopo granular seedados', async () => {
  const [rows] = await sequelize.query(
    "SELECT code FROM core.permissions WHERE code IN ('crm:opportunities:read:own', 'crm:opportunities:read:all') ORDER BY code"
  );
  assert.deepEqual(
    rows.map((r) => r.code),
    ['crm:opportunities:read:all', 'crm:opportunities:read:own']
  );
});
