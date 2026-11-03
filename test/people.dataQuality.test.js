'use strict';

// Caderno (Marco 3, seção 16, "NAY Comercial" — "classifica qualidade do cadastro e documentos
// faltantes"). Achado no Ciclo 2 de verificação cética: dos 8 comportamentos da seção 16, só
// este é determinístico (não depende de LLM, que o projeto não tem integrado em nenhum módulo).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix } = require('./testHelpers');
const peopleService = require('../src/features/people/people.service');
const contactsService = require('../src/features/people/personContacts.service');
const addressesService = require('../src/features/people/personAddresses.service');
const rolesService = require('../src/features/people/personRoles.service');

let tenant;

before(async () => {
  tenant = await getSeedTenant();
});

after(async () => {
  await sequelize.close();
});

test('qualidade do cadastro: pessoa recém-criada (só nome) tem score baixo e lista o que falta', async () => {
  const suffix = uniqueSuffix();
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const created = await peopleService.createPerson(
      { groupId: tenant.groupId, companyId: tenant.companyId, personType: 'PF', legalName: `Pessoa Score ${suffix}` },
      tenant.userId,
      transaction
    );

    const fetched = await peopleService.getPerson(created.id, transaction);

    assert.ok(fetched.dataQuality, 'getPerson deve devolver dataQuality');
    assert.ok(fetched.dataQuality.score < 100, 'cadastro incompleto não pode pontuar 100');
    assert.ok(fetched.dataQuality.score > 0, 'nome preenchido já garante alguma pontuação');
    const missingKeys = fetched.dataQuality.missing.map((m) => m.key);
    assert.ok(missingKeys.includes('taxId'), 'sem CPF/CNPJ deve aparecer em missing');
    assert.ok(missingKeys.includes('contact'), 'sem contato deve aparecer em missing');
    assert.ok(missingKeys.includes('address'), 'sem endereço deve aparecer em missing');
    assert.ok(missingKeys.includes('document'), 'sem documento deve aparecer em missing');
    assert.ok(missingKeys.includes('role'), 'sem papel deve aparecer em missing');
  });
});

test('qualidade do cadastro: pessoa completa (exceto documento) pontua mais alto e documento some de missing depois de preenchido', async () => {
  const suffix = uniqueSuffix();
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const taxIdNormalized = `22233344${suffix}`.slice(0, 11).padEnd(11, '1');
    const created = await peopleService.createPerson(
      { groupId: tenant.groupId, companyId: tenant.companyId, personType: 'PF', legalName: `Pessoa Score Completa ${suffix}`, taxIdNormalized },
      tenant.userId,
      transaction
    );

    await contactsService.createContact(created.id, { contactType: 'EMAIL', valueNormalized: `score+${suffix}@teste.com` }, tenant.userId, transaction);
    await addressesService.createAddress(created.id, { addressLine: 'Rua Teste, 100', city: 'São Paulo', state: 'SP', zipCode: '01000-000' }, tenant.userId, transaction);
    await rolesService.createRole(created.id, { roleCode: 'CLIENTE' }, tenant.userId, transaction);

    const fetched = await peopleService.getPerson(created.id, transaction);
    const missingKeys = fetched.dataQuality.missing.map((m) => m.key);

    assert.deepEqual(missingKeys, ['document'], 'só documento deve faltar');
    assert.equal(fetched.dataQuality.score, Math.round((5 / 6) * 100), 'score deve refletir 5 de 6 checagens atendidas');
  });
});

test('qualidade do cadastro: a propriedade dataQuality sobrevive à serialização JSON (res.json)', async () => {
  const suffix = uniqueSuffix();
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const created = await peopleService.createPerson(
      { groupId: tenant.groupId, companyId: tenant.companyId, personType: 'PF', legalName: `Pessoa Score JSON ${suffix}` },
      tenant.userId,
      transaction
    );
    const fetched = await peopleService.getPerson(created.id, transaction);

    // Regressão direta do bug achado nesta auditoria: Sequelize Model#toJSON() descarta
    // propriedades soltas atribuídas à instância — getPerson precisa devolver objeto PLANO.
    const serialized = JSON.parse(JSON.stringify(fetched));
    assert.ok(serialized.dataQuality, 'dataQuality precisa sobreviver a JSON.stringify, como a resposta HTTP real faz');
    assert.equal(serialized.dataQuality.score, fetched.dataQuality.score);
  });
});
