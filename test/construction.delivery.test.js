'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix } = require('./testHelpers');
const projectsService = require('../src/features/construction/projects.service');
const AppError = require('../src/utils/AppError');

function rejectsWithCode(expectedCode) {
  return (err) => {
    assert.ok(err instanceof AppError, `esperava AppError, recebeu ${err && err.constructor && err.constructor.name}`);
    assert.equal(err.code, expectedCode);
    return true;
  };
}

let tenant;

before(async () => {
  tenant = await getSeedTenant();
});

after(async () => {
  await sequelize.close();
});

async function createTestProject(transaction, status = 'PLANNED') {
  const project = await projectsService.createProject(
    {
      groupId: tenant.groupId,
      companyId: tenant.companyId,
      name: `Obra de teste entrega ${uniqueSuffix()}`,
    },
    tenant.userId,
    transaction
  );
  if (status === 'IN_PROGRESS' || status === 'COMPLETED') {
    await projectsService.transitionProject(project.id, 'IN_PROGRESS', tenant.userId, transaction);
  }
  if (status === 'COMPLETED') {
    await projectsService.transitionProject(project.id, 'COMPLETED', tenant.userId, transaction);
  }
  return projectsService.getProject(project.id, transaction);
}

// --- Máquina de estados: DELIVERED é um estado válido, mas não alcançável pela transição genérica ---

test('delivery: STATUSES inclui DELIVERED como estado terminal do projeto', () => {
  assert.ok(projectsService.STATUSES.includes('DELIVERED'));
});

test('delivery: transitionProject genérico não permite ir direto para DELIVERED (só via gate dedicado)', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const project = await createTestProject(transaction, 'COMPLETED');
    await assert.rejects(
      () => projectsService.transitionProject(project.id, 'DELIVERED', tenant.userId, transaction),
      rejectsWithCode('PROJECT_STATUS_TRANSITION_INVALID')
    );
  });
});

// --- Gate de entrega (M6-25/M6-39/M6-51/M6-65/M6-79/M6-87) ---

test('delivery: deliverProject recusa entregar obra que não está COMPLETED', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const project = await createTestProject(transaction, 'IN_PROGRESS');
    await assert.rejects(
      () => projectsService.deliverProject(project.id, tenant.userId, transaction),
      rejectsWithCode('PROJECT_NOT_COMPLETED')
    );
  });
});

test('delivery: deliverProject entrega obra COMPLETED sem pendência crítica (tabela nonconformities ainda não existe = tratado como "sem pendência")', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const project = await createTestProject(transaction, 'COMPLETED');
    const delivered = await projectsService.deliverProject(project.id, tenant.userId, transaction);
    assert.equal(delivered.status, 'DELIVERED');
  });
});

// M6-65: entregar com pendência crítica bloqueia. A tabela real `construction.nonconformities`
// está sendo criada por outro agente em paralelo (fatia de Não Conformidades) e ainda não foi
// mergeada neste momento — e a credencial de banco disponível para os testes (`nayara_runtime`,
// o usuário de runtime da aplicação, DE PROPÓSITO sem privilégio de CREATE em nenhum schema,
// por princípio de menor privilégio) não pode criar a tabela real nem uma tabela fake via DDL
// para simular a pendência. Para comprovar o bloqueio de verdade SEM precisar de DDL, este
// teste troca temporariamente `sequelize.query` (a mesma função que
// `projects.service.js#hasOpenCriticalNonconformity` chama internamente) por um stub que
// responde como se a tabela existisse e tivesse uma linha OPEN/CRITICAL — exercitando o
// caminho real de `deliverProject` (lock, checagem, erro fail-closed), só sem depender de DDL.
// Restaura `sequelize.query` original no `finally`, então não deixa nenhum estado global preso
// entre testes. Depois do merge da fatia real de Não Conformidades, o ideal é ACRESCENTAR (não
// substituir) um teste de integração de verdade contra a tabela `construction.nonconformities`
// mergeada.
test('delivery: deliverProject BLOQUEIA entrega quando há não conformidade CRITICAL/OPEN vinculada ao projeto', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const project = await createTestProject(transaction, 'COMPLETED');

    const originalQuery = sequelize.query.bind(sequelize);
    sequelize.query = async (sql, options) => {
      if (typeof sql === 'string' && sql.includes('construction"."nonconformities"')) {
        return [[{ '?column?': 1 }]];
      }
      return originalQuery(sql, options);
    };
    try {
      await assert.rejects(
        () => projectsService.deliverProject(project.id, tenant.userId, transaction),
        rejectsWithCode('PROJECT_DELIVERY_BLOCKED_BY_CRITICAL_NONCONFORMITY')
      );
    } finally {
      sequelize.query = originalQuery;
    }

    const reloaded = await projectsService.getProject(project.id, transaction);
    assert.equal(reloaded.status, 'COMPLETED', 'projeto não deveria ter sido transicionado quando bloqueado');
  });
});

test('delivery: hasOpenCriticalNonconformity trata "tabela não existe" (42P01) como "sem pendência"', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    // Sem stub nenhum: a tabela `construction.nonconformities` de fato ainda não existe neste
    // ambiente, então este teste exercita o comportamento REAL do fallback defensivo.
    const blocked = await projectsService.hasOpenCriticalNonconformity(
      tenant.companyId,
      '00000000-0000-0000-0000-000000000000',
      transaction
    );
    assert.equal(blocked, false);
  });
});
