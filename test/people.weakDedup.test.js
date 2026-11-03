'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix } = require('./testHelpers');
const personService = require('../src/features/people/person.service');
const personDedupService = require('../src/features/people/personDedup.service');

// CICLO 4 (Marco 3): a seção 4 do Caderno define 3 níveis de match (forte/médio/fraco). Forte
// (CPF exato) e médio (contato exato) já bloqueiam createPerson por padrão. O match FRACO (nome
// semelhante + endereço/data de nascimento) nunca tinha sido implementado — o próprio comentário
// do código antigo admitia isso. Este arquivo prova o novo `findWeakDuplicateCandidates`:
// NUNCA bloqueia, só sinaliza candidato de revisão.
after(async () => {
  await sequelize.close();
});

test('match fraco: nome parecido + MESMA data de nascimento vira candidato de revisão (não bloqueia)', async () => {
  const tenant = await getSeedTenant();
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const suffix = uniqueSuffix();
    const birthDate = '1990-05-15';

    const original = await personService.createPerson(
      {
        groupId: tenant.groupId,
        companyId: tenant.companyId,
        personType: 'PF',
        legalName: `João da Silva Pereira ${suffix}`,
        birthOrFoundationDate: birthDate,
        allowDuplicate: true,
      },
      tenant.userId,
      transaction
    );

    // Não é bloqueado — allowDuplicate nem precisa ser usado para o match fraco, ele nunca
    // bloqueia (diferente de forte/médio).
    const duplicate = await personService.createPerson(
      {
        groupId: tenant.groupId,
        companyId: tenant.companyId,
        personType: 'PF',
        legalName: `Joao Silva Pereira ${suffix}`, // mesmo primeiro+último token, sem acento
        birthOrFoundationDate: birthDate,
      },
      tenant.userId,
      transaction
    );
    assert.ok(duplicate.id, 'criação não deve ser bloqueada pelo match fraco');

    const candidates = await personDedupService.findWeakDuplicateCandidates(
      { legalName: `Joao Silva Pereira ${suffix}`, birthOrFoundationDate: birthDate, excludePersonId: duplicate.id },
      transaction
    );

    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].personId, original.id);
    assert.equal(candidates[0].reason, 'NOME_E_DATA_NASCIMENTO_SEMELHANTES');
  });
});

test('match fraco: nomes completamente diferentes não geram candidato, mesmo com a mesma data de nascimento', async () => {
  const tenant = await getSeedTenant();
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const suffix = uniqueSuffix();
    const birthDate = '1985-01-01';

    await personService.createPerson(
      {
        groupId: tenant.groupId,
        companyId: tenant.companyId,
        personType: 'PF',
        legalName: `Carlos Eduardo Nunes ${suffix}`,
        birthOrFoundationDate: birthDate,
        allowDuplicate: true,
      },
      tenant.userId,
      transaction
    );

    const candidates = await personDedupService.findWeakDuplicateCandidates(
      { legalName: `Fernanda Albuquerque ${suffix}`, birthOrFoundationDate: birthDate },
      transaction
    );

    assert.equal(candidates.length, 0, 'nomes sem semelhança não devem gerar candidato, mesmo com data de nascimento igual');
  });
});

test('match fraco: sem nome, sem data de nascimento e sem endereço não executa nenhuma checagem (retorna vazio)', async () => {
  const tenant = await getSeedTenant();
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const candidates = await personDedupService.findWeakDuplicateCandidates({}, transaction);
    assert.deepEqual(candidates, []);
  });
});
