'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix } = require('./testHelpers');
const projectsService = require('../src/features/construction/projects.service');
const budgetsService = require('../src/features/construction/budgets.service');
const marginRulesService = require('../src/features/construction/marginRules.service');
const nonconformitiesService = require('../src/features/construction/nonconformities.service');
const maintenanceCasesService = require('../src/features/construction/maintenanceCases.service');
const propertiesService = require('../src/features/properties/properties.service');
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

function withTenant(fields) {
  return { groupId: tenant.groupId, companyId: tenant.companyId, ...fields };
}

// GAP REAL CORRIGIDO (CI quebrado, fresh DB sem seeds de real_estate.properties, 08/10/2026):
// antes dependia de uma property incidental já existente no banco (SELECT ... LIMIT 1), que só
// "funcionava" no banco de dev compartilhado (dados acumulados de testes manuais).
async function createProperty(transaction) {
  const suffix = uniqueSuffix();
  return propertiesService.createProperty(
    withTenant({
      title: `Imóvel entrega ${suffix}`,
      internalCode: `ENTREGA-${suffix}`,
      propertyType: 'RESIDENTIAL',
    }),
    tenant.userId,
    transaction
  );
}

// M6-18: percorre a máquina de estados EXATA da fonte até o status pedido — cada etapa via o
// mecanismo real (aprovar orçamento avança PLANNED->BUDGETED automaticamente, o resto via
// transitionProject genérico).
async function createTestProject(transaction, targetStatus = 'PLANNED') {
  const project = await projectsService.createProject(
    withTenant({
      name: `Obra de teste entrega ${uniqueSuffix()}`,
      responsibleUserId: tenant.userId,
      startsAt: '2026-10-01',
      endsAtPlanned: '2027-10-01',
    }),
    tenant.userId,
    transaction
  );
  if (targetStatus === 'PLANNED') return project;

  await marginRulesService.createMarginRule(withTenant({ minMarginPct: 10 }), tenant.userId, transaction);
  const budget = await budgetsService.createBudget(project.id, withTenant({}), tenant.userId, transaction);
  await budgetsService.approveBudget(budget.id, tenant.userId, transaction); // PLANNED -> BUDGETED
  if (targetStatus === 'BUDGETED') return projectsService.getProject(project.id, transaction);

  await projectsService.transitionProject(project.id, 'READY', tenant.userId, transaction);
  if (targetStatus === 'READY') return projectsService.getProject(project.id, transaction);

  await projectsService.transitionProject(project.id, 'ACTIVE', tenant.userId, transaction);
  if (targetStatus === 'ACTIVE') return projectsService.getProject(project.id, transaction);

  await projectsService.transitionProject(project.id, 'FINAL_INSPECTION', tenant.userId, transaction);
  return projectsService.getProject(project.id, transaction);
}

// --- Máquina de estados: DELIVERED é um estado válido, mas não alcançável pela transição genérica ---

test('delivery: STATUSES inclui os 8 estados exatos da fonte + CANCELLED', () => {
  for (const status of ['PLANNED', 'BUDGETED', 'READY', 'ACTIVE', 'PAUSED', 'FINAL_INSPECTION', 'DELIVERED', 'WARRANTY', 'CLOSED', 'CANCELLED']) {
    assert.ok(projectsService.STATUSES.includes(status), `falta o status ${status}`);
  }
});

test('delivery: transitionProject genérico não permite ir direto para DELIVERED (só via gate dedicado)', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const project = await createTestProject(transaction, 'FINAL_INSPECTION');
    await assert.rejects(
      () => projectsService.transitionProject(project.id, 'DELIVERED', tenant.userId, transaction),
      rejectsWithCode('PROJECT_STATUS_TRANSITION_INVALID')
    );
  });
});

// BUG REAL CRÍTICO CORRIGIDO (achado numa auditoria final do Marco 6, 30/09/2026): a transição
// genérica permitia pular PLANNED->BUDGETED sem passar pelo gate approveBudget() — nenhuma
// margem mínima validada, nenhuma baseline congelada. Mesmo raciocínio de DELIVERED/WARRANTY/
// CLOSED: BUDGETED só é alcançável de verdade aprovando o orçamento agregado.
test('delivery: transitionProject genérico não permite ir direto para BUDGETED (só via approveBudget)', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const project = await createTestProject(transaction, 'PLANNED');
    await assert.rejects(
      () => projectsService.transitionProject(project.id, 'BUDGETED', tenant.userId, transaction),
      rejectsWithCode('PROJECT_STATUS_TRANSITION_INVALID')
    );
  });
});

test('delivery: máquina de estados completa PLANNED->BUDGETED->READY->ACTIVE->PAUSED->ACTIVE->FINAL_INSPECTION funciona de ponta a ponta', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const project = await createTestProject(transaction, 'ACTIVE');
    assert.equal(project.status, 'ACTIVE');

    const paused = await projectsService.transitionProject(project.id, 'PAUSED', tenant.userId, transaction);
    assert.equal(paused.status, 'PAUSED');

    const resumed = await projectsService.transitionProject(project.id, 'ACTIVE', tenant.userId, transaction);
    assert.equal(resumed.status, 'ACTIVE');

    const finalInspection = await projectsService.transitionProject(project.id, 'FINAL_INSPECTION', tenant.userId, transaction);
    assert.equal(finalInspection.status, 'FINAL_INSPECTION');
    assert.ok(finalInspection.actualEndDate, 'actualEndDate deve ser preenchido automaticamente ao entrar em FINAL_INSPECTION');
  });
});

// Bug real corrigido nesta auditoria (rodada 46, 2026-10-05): o contrato (TAB-0700, "Banco de
// Dados Físico BLINDADO") trata budget_amount/start_date/planned_end_date/manager_user_id como
// NOT NULL — mas nada impedia uma obra chegar a ACTIVE sem nenhum desses campos. O gate certo
// é exigir os campos no momento em que a obra começa a ser executada (READY -> ACTIVE), sem
// quebrar o fluxo real de preencher os dados em etapas (PLANNED -> BUDGETED -> READY).
test('delivery: READY -> ACTIVE exige orçamento/cronograma/responsável preenchidos (TAB-0700)', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const project = await projectsService.createProject(
      withTenant({ name: `Obra sem dados obrigatórios ${uniqueSuffix()}` }),
      tenant.userId,
      transaction
    );
    await marginRulesService.createMarginRule(withTenant({ minMarginPct: 10 }), tenant.userId, transaction);
    const budget = await budgetsService.createBudget(project.id, withTenant({}), tenant.userId, transaction);
    await budgetsService.approveBudget(budget.id, tenant.userId, transaction);
    await projectsService.transitionProject(project.id, 'READY', tenant.userId, transaction);

    await assert.rejects(
      () => projectsService.transitionProject(project.id, 'ACTIVE', tenant.userId, transaction),
      (err) => {
        assert.equal(err.code, 'PROJECT_MISSING_REQUIRED_FIELDS');
        // budgetAmount já deveria estar preenchido pelo approveBudget (bug corrigido nesta
        // mesma rodada) — só faltam startsAt/endsAtPlanned/responsibleUserId.
        assert.ok(!err.message.includes('orçamento'), 'approveBudget precisa sincronizar project.budgetAmount automaticamente');
        assert.ok(err.message.includes('data de início'));
        assert.ok(err.message.includes('responsável'));
        return true;
      }
    );

    await projectsService.updateProject(
      project.id,
      { responsibleUserId: tenant.userId, startsAt: '2026-10-01', endsAtPlanned: '2027-10-01' },
      tenant.userId,
      transaction
    );
    const active = await projectsService.transitionProject(project.id, 'ACTIVE', tenant.userId, transaction);
    assert.equal(active.status, 'ACTIVE');
  });
});

// --- Gate de entrega (M6-25/M6-39/M6-51/M6-65/M6-79/M6-87) ---

test('delivery: deliverProject recusa entregar obra que não está FINAL_INSPECTION', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const project = await createTestProject(transaction, 'ACTIVE');
    await assert.rejects(
      () => projectsService.deliverProject(project.id, tenant.userId, transaction),
      rejectsWithCode('PROJECT_NOT_READY_FOR_DELIVERY')
    );
  });
});

test('delivery: deliverProject entrega obra FINAL_INSPECTION sem pendência crítica e avança direto para WARRANTY', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const project = await createTestProject(transaction, 'FINAL_INSPECTION');
    const delivered = await projectsService.deliverProject(project.id, tenant.userId, transaction);
    // M6-18: DELIVERED é instantâneo — a mesma chamada já avança para WARRANTY.
    assert.equal(delivered.status, 'WARRANTY');
  });
});

// M6-65: entregar com pendência crítica bloqueia — teste de integração real contra a tabela
// `construction.nonconformities` (já mergeada), sem stub.
test('delivery: deliverProject BLOQUEIA entrega quando há não conformidade CRITICAL/OPEN vinculada ao projeto', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const project = await createTestProject(transaction, 'FINAL_INSPECTION');
    await nonconformitiesService.createNonconformity(
      project.id,
      withTenant({ description: 'Rachadura estrutural', severity: 'CRITICAL', responsibleUserId: tenant.userId, beforeEvidenceFileIds: ['99999999-9999-9999-9999-999999999999'] }),
      tenant.userId,
      transaction
    );

    await assert.rejects(
      () => projectsService.deliverProject(project.id, tenant.userId, transaction),
      rejectsWithCode('PROJECT_DELIVERY_BLOCKED_BY_CRITICAL_NONCONFORMITY')
    );

    const reloaded = await projectsService.getProject(project.id, transaction);
    assert.equal(reloaded.status, 'FINAL_INSPECTION', 'projeto não deveria ter sido transicionado quando bloqueado');
  });
});

// BUG REAL CORRIGIDO (auditoria externa Nayara, reteste 09/10/2026 — F1): hasOpenCriticalNonconformity
// tinha um fallback de fase antiga que tratava erro de Postgres 42P01 (tabela ausente) como
// "sem pendência crítica", LIBERANDO a entrega mesmo sem conseguir confirmar a ausência de NC
// crítica — fail-open. Simula o erro real (monkey-patch de sequelize.query, restaurado no
// finally) e confirma que deliverProject agora PROPAGA o erro, bloqueando a entrega, em vez de
// liberar silenciosamente.
test('delivery: deliverProject NÃO libera a obra quando a consulta de NC falha (fail-closed, não fail-open)', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const project = await createTestProject(transaction, 'FINAL_INSPECTION');

    const originalQuery = sequelize.query.bind(sequelize);
    sequelize.query = async (sql, options) => {
      if (typeof sql === 'string' && sql.includes('"construction"."nonconformities"') && sql.includes('SELECT 1')) {
        const err = new Error('relation "construction.nonconformities" does not exist');
        err.original = { code: '42P01' };
        throw err;
      }
      return originalQuery(sql, options);
    };

    try {
      await assert.rejects(
        () => projectsService.deliverProject(project.id, tenant.userId, transaction),
        (err) => {
          assert.ok(err && err.original && err.original.code === '42P01', 'esperava o erro real de banco propagado, não engolido');
          return true;
        }
      );
    } finally {
      sequelize.query = originalQuery;
    }

    const reloaded = await projectsService.getProject(project.id, transaction);
    assert.equal(reloaded.status, 'FINAL_INSPECTION', 'projeto NÃO pode avançar quando a verificação de NC crítica falha — fail-closed');
  });
});

// BUG REAL CORRIGIDO (auditoria "loop até secar", rodada 60, 2026-10-06): checkQualityItem
// sempre abria a NC automática com severity='MEDIUM' fixo — reprovar um item ESTRUTURA/
// HIDRAULICA/ELETRICA nunca bloqueava a entrega, porque o gate só considera NC CRITICAL.
test('delivery: reprovar item de checklist ESTRUTURA abre NC CRITICAL e BLOQUEIA a entrega', async () => {
  const qualityChecklistService = require('../src/features/construction/qualityChecklist.service');
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const project = await createTestProject(transaction, 'FINAL_INSPECTION');
    const item = await qualityChecklistService.createQualityItem(
      project.id,
      withTenant({ item: 'Viga de sustentação sem fissuras', category: 'ESTRUTURA' }),
      tenant.userId,
      transaction
    );
    await qualityChecklistService.checkQualityItem(
      item.id,
      { status: 'NOT_OK', notes: 'Fissura visível na viga.', evidenceFileIds: ['aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'] },
      tenant.userId,
      transaction
    );

    await assert.rejects(
      () => projectsService.deliverProject(project.id, tenant.userId, transaction),
      rejectsWithCode('PROJECT_DELIVERY_BLOCKED_BY_CRITICAL_NONCONFORMITY')
    );
  });
});

test('delivery: hasOpenCriticalNonconformity retorna false quando não há nenhuma NC crítica aberta', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const project = await createTestProject(transaction, 'FINAL_INSPECTION');
    const blocked = await projectsService.hasOpenCriticalNonconformity(tenant.companyId, project.id, transaction);
    assert.equal(blocked, false);
  });
});

// --- M6-18: fechamento definitivo (WARRANTY -> CLOSED) ---

test('closeProjectWarranty: bloqueia fechar com caso de garantia ainda aberto', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const project = await createTestProject(transaction, 'FINAL_INSPECTION');
    const delivered = await projectsService.deliverProject(project.id, tenant.userId, transaction);
    assert.equal(delivered.status, 'WARRANTY');

    const property = await createProperty(transaction);
    await maintenanceCasesService.createMaintenanceCase(
      withTenant({ propertyId: property.id, projectId: project.id, description: 'Infiltração', severity: 'MEDIUM' }),
      tenant.userId,
      transaction
    );

    await assert.rejects(
      () => projectsService.closeProjectWarranty(project.id, tenant.userId, transaction),
      rejectsWithCode('PROJECT_WARRANTY_CLOSE_BLOCKED_BY_OPEN_CASE')
    );
  });
});

// Bug real corrigido nesta auditoria (rodada 20, 2026-10-05): closeProjectWarranty contava
// MaintenanceCase soft-deletado (deleted_at preenchido via DELETE /construction/maintenance-cases/:id,
// que não exige CLOSED pra excluir) como "ainda aberto" pra sempre, travando a garantia da obra
// de forma irreversível contra um registro que não aparece em nenhuma listagem/UI do sistema.
test('closeProjectWarranty: caso de garantia excluído (soft delete) não bloqueia o fechamento', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const project = await createTestProject(transaction, 'FINAL_INSPECTION');
    await projectsService.deliverProject(project.id, tenant.userId, transaction);

    const property = await createProperty(transaction);
    const warrantyCase = await maintenanceCasesService.createMaintenanceCase(
      withTenant({ propertyId: property.id, projectId: project.id, description: 'Caso aberto por engano', severity: 'LOW' }),
      tenant.userId,
      transaction
    );

    await maintenanceCasesService.removeMaintenanceCase(warrantyCase.id, tenant.userId, transaction);

    const closed = await projectsService.closeProjectWarranty(project.id, tenant.userId, transaction);
    assert.equal(closed.status, 'CLOSED');
  });
});

test('closeProjectWarranty: fecha a obra quando todos os casos de garantia estão CLOSED', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const project = await createTestProject(transaction, 'FINAL_INSPECTION');
    await projectsService.deliverProject(project.id, tenant.userId, transaction);

    const property = await createProperty(transaction);
    const warrantyCase = await maintenanceCasesService.createMaintenanceCase(
      withTenant({ propertyId: property.id, projectId: project.id, description: 'Infiltração', severity: 'MEDIUM' }),
      tenant.userId,
      transaction
    );
    await maintenanceCasesService.updateMaintenanceCase(warrantyCase.id, { status: 'RESOLVED' }, tenant.userId, transaction);
    await maintenanceCasesService.createWarrantyAction(warrantyCase.id, { description: 'Reparo da infiltração.' }, tenant.userId, transaction);
    await maintenanceCasesService.updateMaintenanceCase(
      warrantyCase.id,
      {
        status: 'CLOSED',
        rootCauseCode: 'WORKMANSHIP',
        beforeMediaFileIds: ['77777777-7777-7777-7777-777777777777'],
        afterMediaFileIds: ['88888888-8888-8888-8888-888888888888'],
      },
      tenant.userId,
      transaction
    );

    const closed = await projectsService.closeProjectWarranty(project.id, tenant.userId, transaction);
    assert.equal(closed.status, 'CLOSED');
  });
});

test('closeProjectWarranty: recusa fechar obra que não está WARRANTY', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const project = await createTestProject(transaction, 'ACTIVE');
    await assert.rejects(
      () => projectsService.closeProjectWarranty(project.id, tenant.userId, transaction),
      rejectsWithCode('PROJECT_NOT_IN_WARRANTY')
    );
  });
});

// BUG REAL CORRIGIDO (auditoria "loop até secar", rodada 55, 2026-10-05): removeProject (soft
// delete) não tinha guarda alguma — dava pra excluir uma obra com etapas/orçamento/garantia
// vinculados, que ficavam órfãos mas vivos e operáveis. Agora bloqueia fail-closed.
test('removeProject: recusa excluir obra que já tem orçamento vinculado (PROJECT_DELETE_HAS_DEPENDENTS)', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const project = await createTestProject(transaction, 'BUDGETED');
    await assert.rejects(
      () => projectsService.removeProject(project.id, tenant.userId, transaction),
      rejectsWithCode('PROJECT_DELETE_HAS_DEPENDENTS')
    );
  });
});

test('removeProject: recusa excluir obra que já tem chamado de garantia vinculado', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const project = await createTestProject(transaction, 'PLANNED');
    const property = await createProperty(transaction);
    await maintenanceCasesService.createMaintenanceCase(
      withTenant({ propertyId: property.id, projectId: project.id, description: 'Infiltração', severity: 'LOW' }),
      tenant.userId,
      transaction
    );
    await assert.rejects(
      () => projectsService.removeProject(project.id, tenant.userId, transaction),
      rejectsWithCode('PROJECT_DELETE_HAS_DEPENDENTS')
    );
  });
});

test('removeProject: exclui normalmente obra sem nenhum vínculo (etapa/orçamento/garantia)', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const project = await createTestProject(transaction, 'PLANNED');
    await projectsService.removeProject(project.id, tenant.userId, transaction);
    await assert.rejects(
      () => projectsService.getProject(project.id, transaction),
      rejectsWithCode('PROJECT_NOT_FOUND')
    );
  });
});

// BUG REAL CORRIGIDO ("ciclos até secar", Ciclo 16, Frente A — concorrência real, 09/10/2026):
// nem removeProject nem createBudget tomavam lock pessimista na linha do Project — a contagem
// de dependentes do remove e o insert do create corriam sem nenhuma serialização entre si.
// Confirmado empiricamente (duas transações commitadas) ANTES do fix: ambos tinham sucesso,
// deixando o projeto soft-deletado com um Budget vivo e órfão apontando pra ele. Concorrência
// real precisa de transações COMMITADAS (duas conexões), mesmo padrão de M6-67.
test('removeProject: concorrente com createBudget — não pode excluir a obra se um orçamento foi criado antes do commit (lock pessimista)', async () => {
  async function withCommitted(fn) {
    const t = await sequelize.transaction();
    try {
      await sequelize.query('SET LOCAL app.group_id = :g', { replacements: { g: tenant.groupId }, transaction: t });
      await sequelize.query('SET LOCAL app.company_id = :c', { replacements: { c: tenant.companyId }, transaction: t });
      await sequelize.query('SET LOCAL app.user_id = :u', { replacements: { u: tenant.userId }, transaction: t });
      const r = await fn(t);
      await t.commit();
      return r;
    } catch (err) {
      await t.rollback();
      throw err;
    }
  }

  const { Project: ProjectModel, Budget: BudgetModel } = require('../src/models');

  const projectId = await withCommitted(async (t) => {
    const project = await projectsService.createProject(withTenant({ name: `HOMO QA Obra concorrencia remove ${uniqueSuffix()}` }), tenant.userId, t);
    return project.id;
  });

  try {
    // Transação A: cria o Budget, mas segura o lock (pg_sleep ANTES do commit) para garantir
    // que a transação B (remove) realmente concorra com o lock ainda aberto.
    const results = await Promise.allSettled([
      withCommitted(async (t) => {
        const budget = await budgetsService.createBudget(projectId, withTenant({}), tenant.userId, t);
        await sequelize.query('SELECT pg_sleep(1)', { transaction: t });
        return budget;
      }),
      (async () => {
        await new Promise((resolve) => setTimeout(resolve, 200));
        return withCommitted((t) => projectsService.removeProject(projectId, tenant.userId, t));
      })(),
    ]);

    const [budgetResult, removeResult] = results;
    assert.equal(budgetResult.status, 'fulfilled', 'a criação do orçamento deve ter sucesso');
    assert.equal(
      removeResult.status,
      'rejected',
      'a exclusão concorrente deve esperar o lock e então ver o orçamento já criado — não pode ter sucesso'
    );
    assert.equal(removeResult.reason.code, 'PROJECT_DELETE_HAS_DEPENDENTS');

    await withCommitted(async (t) => {
      const projectStillExists = await ProjectModel.findByPk(projectId, { transaction: t });
      assert.ok(projectStillExists, 'a obra não pode ter sido excluída — o orçamento criado precisa continuar vinculado a uma obra viva');
      const budgets = await BudgetModel.findAll({ where: { projectId }, transaction: t });
      assert.equal(budgets.length, 1, 'o orçamento criado precisa continuar apontando para uma obra não excluída');
    });
  } finally {
    await withCommitted(async (t) => {
      await BudgetModel.destroy({ where: { projectId }, transaction: t, force: true });
      await ProjectModel.destroy({ where: { id: projectId }, transaction: t, force: true });
    });
  }
});
