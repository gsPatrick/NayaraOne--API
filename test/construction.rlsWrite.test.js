'use strict';

// M6-66: teste dedicado de bloqueio de ESCRITA cross-tenant (não só leitura/visibilidade, já
// coberto em M6-57). Cria um recurso de Obras sob o tenant real, muda o contexto de tenant
// DENTRO da mesma transação para uma empresa diferente, e tenta uma UPDATE direta via SQL
// (bypassando toda validação de camada de serviço) contra o registro do tenant original —
// confirma que o RLS bloqueia a escrita no nível do banco, não só a leitura.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix } = require('./testHelpers');
const projectsService = require('../src/features/construction/projects.service');
const budgetLinesService = require('../src/features/construction/budgetLines.service');

let tenant;
let otherCompanyId;

before(async () => {
  tenant = await getSeedTenant();
  const [[row]] = await sequelize.query(
    'SELECT id FROM core.companies WHERE id != :companyId LIMIT 1',
    { replacements: { companyId: tenant.companyId } }
  );
  otherCompanyId = row ? row.id : '00000000-0000-0000-0000-000000000000';
});

after(async () => {
  await sequelize.close();
});

function withTenant(fields) {
  return { groupId: tenant.groupId, companyId: tenant.companyId, ...fields };
}

test('M6-66: UPDATE direta em linha de orçamento de outra empresa é bloqueada pelo RLS (não só a leitura)', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const project = await projectsService.createProject(
      withTenant({ name: `HOMO QA Obra RLS-write ${uniqueSuffix()}` }),
      tenant.userId,
      transaction
    );
    const line = await budgetLinesService.createBudgetLine(
      project.id,
      withTenant({ category: 'Material', plannedAmount: 1000 }),
      tenant.userId,
      transaction
    );

    // Muda o contexto de tenant DENTRO da mesma transação para outra empresa real (ou um UUID
    // inexistente, se o seed só tiver uma empresa) — tenta um UPDATE direto via SQL, contornando
    // completamente a camada de serviço, contra a linha que pertence ao tenant ORIGINAL.
    await sequelize.query('SET LOCAL app.company_id = :otherCompanyId', {
      replacements: { otherCompanyId },
      transaction,
    });

    const [, updateResult] = await sequelize.query(
      `UPDATE "construction"."budget_lines" SET category = 'HACKED' WHERE id = :lineId`,
      { replacements: { lineId: line.id }, transaction }
    );
    assert.equal(updateResult.rowCount, 0, 'UPDATE cross-tenant não deve afetar nenhuma linha (RLS bloqueia a escrita)');

    // Volta pro contexto de tenant original e confirma que o valor NÃO foi alterado.
    await sequelize.query('SET LOCAL app.company_id = :companyId', {
      replacements: { companyId: tenant.companyId },
      transaction,
    });
    const reloaded = await budgetLinesService.getBudgetLine(line.id, transaction);
    assert.equal(reloaded.category, 'Material', 'valor original deve permanecer intacto após a tentativa de escrita cross-tenant');
  });
});
