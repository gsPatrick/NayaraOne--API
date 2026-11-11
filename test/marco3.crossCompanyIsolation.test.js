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

// REVISTO EM 10/11/2026 (vazamento achado ao vivo na homologação): esta rodada tinha concluído que people.persons era
// compartilhado por GRUPO e que isso era o CRMX-015. Não é: a política de leitura do próprio Caderno (§26,
// persons_company_select) restringe por company_scope_allows(company_id, empresa do contexto); só a política de escrita
// FOR ALL por group_id, somada por OR, anulava essa restrição. A migration 20260101009965 trocou o FOR ALL por políticas
// de INSERT/UPDATE/DELETE com o mesmo escopo de empresa. Decisão e trecho do livro em
// Maturacao/demandas/decisoes-de-implementacao.md. As provas com duas empresas do MESMO grupo estão em
// test/people.mesmoGrupo.rls.test.js e test/people.mesmoGrupo.http.test.js.
test('CRMX-015/CRM-TS-012: people.persons — outro grupo e outra empresa não enxergam a pessoa', async () => {
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

    // Cenário 2: outra empresa (qualquer grupo) também não vê a pessoa: o isolamento é por empresa.
    await sequelize.query('SET LOCAL app.group_id = :groupId', { replacements: { groupId: tenant.groupId }, transaction });
    await sequelize.query('SET LOCAL app.company_id = :otherCompanyId', { replacements: { otherCompanyId }, transaction });
    const [fromOtherCompanySameGroup] = await sequelize.query('SELECT id FROM "people"."persons" WHERE id = :id', {
      replacements: { id: person.id },
      transaction,
    });
    assert.equal(fromOtherCompanySameGroup.length, 0, 'outra empresa não pode ver a pessoa (persons_company_select do Caderno §26)');
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
