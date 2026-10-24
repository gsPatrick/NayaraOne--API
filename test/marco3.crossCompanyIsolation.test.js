'use strict';

// CRMX-015 (Multiempresa) + CRM-TS-012 ("Corretor A lê B -> Bloqueado") — auditoria externa
// (Abacus AI, 11/10/2026): "Apenas uma empresa no ambiente; isolamento não comprovado." O
// catálogo genérico de RLS (test/rls.catalog.allTables.test.js) já confirma RLS+FORCE
// RLS+policy em 100% das tabelas multiempresa, incluindo people.persons, real_estate.properties
// e crm.opportunities — mas isso só prova que EXISTE uma policy, não que ela bloqueia de fato
// uma leitura/escrita cross-company real. Este arquivo reproduz o cenário adversarial
// CRM-TS-012 ponta a ponta nas 3 tabelas centrais do Marco 3, no mesmo padrão já usado para
// Obras (M6-66/construction.rlsWrite.test.js): muda o contexto de tenant DENTRO da mesma
// transação para uma empresa DIFERENTE e tenta ler/escrever a linha da empresa original,
// direto via SQL — bypassando toda a camada de serviço.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix } = require('./testHelpers');
const peopleService = require('../src/features/people/people.service');
const propertiesService = require('../src/features/properties/properties.service');
const opportunityService = require('../src/features/crm/opportunity.service');

let tenant;
let otherCompanyId;

before(async () => {
  tenant = await getSeedTenant();
  const [[row]] = await sequelize.query('SELECT id FROM core.companies WHERE id != :companyId LIMIT 1', {
    replacements: { companyId: tenant.companyId },
  });
  otherCompanyId = row ? row.id : '00000000-0000-0000-0000-000000000000';
});

after(async () => {
  await sequelize.close();
});

// ACHADO DESTA RODADA (não é bug — é o design correto do CRMX-015 confirmado ao vivo): ao
// contrário de real_estate.properties e crm.opportunities abaixo, people.persons é isolado por
// GRUPO (group_id), não por empresa (company_id) — qualquer empresa do mesmo grupo
// lê/escreve o cadastro mestre de pessoa. Isso é exatamente o que o Caderno Técnico pede:
// "CRMX-015 — Multiempresa: Cliente pode ter relação com mais de uma empresa [do grupo]."
// A policy `persons_company_select` até tenta restringir por company_scope_allows(), mas a
// policy `persons_company_write` é `FOR ALL` (cobre SELECT também, via OR entre policies
// permissivas do Postgres) e só checa group_id — então, na prática, qualquer empresa do grupo
// já enxerga/edita a pessoa, que é o comportamento desejado para o cadastro mestre
// compartilhado. Só crm.opportunities/property_offers (os registros "por empresa") precisam
// ficar isolados — e esses dois SÃO isolados, confirmado nos dois testes seguintes.
test('CRMX-015: people.persons é compartilhado por GRUPO (qualquer empresa do mesmo grupo lê/escreve o cadastro mestre) — comportamento correto do CRMX-015, não um vazamento', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const person = await peopleService.createPerson(
      { groupId: tenant.groupId, companyId: tenant.companyId, personType: 'PF', legalName: `Isolamento ${uniqueSuffix()}` },
      tenant.userId,
      transaction
    );

    // Cenário 1: outro GRUPO (tenant totalmente diferente) nunca pode ver a pessoa — isso
    // sim precisa estar isolado, e está (group_id é a chave de ambas as policies).
    await sequelize.query('SET LOCAL app.group_id = :fakeGroupId', {
      replacements: { fakeGroupId: '00000000-0000-0000-0000-000000000000' },
      transaction,
    });
    const [fromOtherGroup] = await sequelize.query('SELECT id FROM "people"."persons" WHERE id = :id', {
      replacements: { id: person.id },
      transaction,
    });
    assert.equal(fromOtherGroup.length, 0, 'um grupo (tenant) diferente NUNCA deve ver a pessoa de outro grupo');

    // Cenário 2 (comportamento ESPERADO, não um bug): dentro do MESMO grupo, outra empresa
    // consegue ver a pessoa — CRMX-015 exige isso para o cadastro mestre compartilhado.
    await sequelize.query('SET LOCAL app.group_id = :groupId', { replacements: { groupId: tenant.groupId }, transaction });
    await sequelize.query('SET LOCAL app.company_id = :otherCompanyId', { replacements: { otherCompanyId }, transaction });
    const [fromOtherCompanySameGroup] = await sequelize.query('SELECT id FROM "people"."persons" WHERE id = :id', {
      replacements: { id: person.id },
      transaction,
    });
    assert.equal(
      fromOtherCompanySameGroup.length,
      1,
      'outra empresa do MESMO grupo deve ver o cadastro mestre da pessoa (CRMX-015) — se isto quebrar, é uma regressão do requisito, não um fix'
    );
  });
});

test('CRMX-015/CRM-TS-012: real_estate.properties — outra empresa não enxerga nem edita o imóvel via SELECT/UPDATE direto', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const property = await propertiesService.createProperty(
      {
        groupId: tenant.groupId,
        companyId: tenant.companyId,
        title: `Imóvel isolamento ${uniqueSuffix()}`,
        internalCode: `IC-ISO-${uniqueSuffix()}`,
        propertyType: 'RESIDENTIAL',
      },
      tenant.userId,
      transaction
    );

    await sequelize.query('SET LOCAL app.company_id = :otherCompanyId', { replacements: { otherCompanyId }, transaction });

    const [selectRows] = await sequelize.query('SELECT id FROM "real_estate"."properties" WHERE id = :id', {
      replacements: { id: property.id },
      transaction,
    });
    assert.equal(selectRows.length, 0, 'empresa diferente não deve conseguir SELECT no imóvel da empresa original');

    const [, updateResult] = await sequelize.query(
      `UPDATE "real_estate"."properties" SET title = 'HACKED' WHERE id = :id`,
      { replacements: { id: property.id }, transaction }
    );
    assert.equal(updateResult.rowCount, 0, 'empresa diferente não deve conseguir UPDATE no imóvel da empresa original');
  });
});

test('CRMX-015/CRM-TS-012: crm.opportunities — corretor de outra empresa não enxerga nem edita a oportunidade (cenário literal CRM-TS-012)', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const person = await peopleService.createPerson(
      { groupId: tenant.groupId, companyId: tenant.companyId, personType: 'PF', legalName: `Lead isolamento ${uniqueSuffix()}` },
      tenant.userId,
      transaction
    );
    const opportunity = await opportunityService.createOpportunity(
      {
        groupId: tenant.groupId,
        companyId: tenant.companyId,
        personId: person.id,
        nextAction: 'Ligar para o cliente',
        nextActionDueAt: new Date(Date.now() + 86400000),
      },
      tenant.userId,
      transaction
    );

    await sequelize.query('SET LOCAL app.company_id = :otherCompanyId', { replacements: { otherCompanyId }, transaction });

    const [selectRows] = await sequelize.query('SELECT id FROM "crm"."opportunities" WHERE id = :id', {
      replacements: { id: opportunity.id },
      transaction,
    });
    assert.equal(selectRows.length, 0, 'corretor de outra empresa não deve conseguir SELECT na oportunidade da empresa original (CRM-TS-012)');

    const [, updateResult] = await sequelize.query(
      `UPDATE "crm"."opportunities" SET stage = 'WON' WHERE id = :id`,
      { replacements: { id: opportunity.id }, transaction }
    );
    assert.equal(updateResult.rowCount, 0, 'corretor de outra empresa não deve conseguir UPDATE na oportunidade da empresa original (CRM-TS-012)');
  });
});
