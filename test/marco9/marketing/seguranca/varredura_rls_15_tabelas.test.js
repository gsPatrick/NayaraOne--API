'use strict';

// M9-D441 segurança 1 (Caderno §14 e DoD "RLS/redaction"): as 15 tabelas do livro com DUAS empresas. Cada empresa tem linha em todas; cada uma enxerga só as suas; sem contexto não se enxerga nada
// (fail-closed); gravar com a empresa da outra é recusado pela RLS; e nenhuma tabela do schema marketing fica de fora da conferência. Banco descartável, role de runtime, tudo desfeito no fim.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { sequelize } = require('../../../../src/models');
const { withRollbackTenantTransaction } = require('../../../testHelpers');
const { prepararTenants } = require('../../../helpers/marketingExecucao');
const { q } = require('../../../helpers/m9d412Fixtures');
const { TABELAS_DO_LIVRO } = require('../../../../scripts/marketing/ci/lib/migracoes');
const { popular15, setContext } = require('../../_helpers/mktSegDados');

let A;
let B;
before(async () => { ({ tenantA: A, tenantB: B } = await prepararTenants()); });
after(async () => { await sequelize.close(); });

const empresasVistas = async (t, tabela) => (await q(t, `SELECT company_id, count(*)::int AS n FROM marketing.${tabela} GROUP BY company_id`));

test('varredura_rls_15_tabelas', async (ctx) => {
  assert.equal(TABELAS_DO_LIVRO.length, 15, 'o livro tem 15 tabelas');
  await withRollbackTenantTransaction(A, async (t) => {
    await popular15(t, A);
    await setContext(t, B);
    await popular15(t, B);
    const noSchema = (await q(t, "SELECT c.relname AS n FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace WHERE ns.nspname = 'marketing' AND c.relkind IN ('r','p') AND NOT c.relispartition")).map((r) => r.n);
    for (const tabela of TABELAS_DO_LIVRO) assert.ok(noSchema.includes(tabela), `falta marketing.${tabela}`);
    const resultado = [];
    for (const tabela of TABELAS_DO_LIVRO) {
      // cada empresa enxerga só as suas linhas, e tem ao menos uma
      await setContext(t, A);
      const deA = await empresasVistas(t, tabela);
      assert.deepEqual(deA.map((r) => r.company_id), [A.companyId], `${tabela}: a empresa A enxerga só a própria (e tem linha)`);
      await setContext(t, B);
      const deB = await empresasVistas(t, tabela);
      assert.deepEqual(deB.map((r) => r.company_id), [B.companyId], `${tabela}: a empresa B enxerga só a própria (e tem linha)`);
      // sem contexto (fail-closed): nada
      await setContext(t, null);
      assert.equal((await q(t, `SELECT count(*)::int AS n FROM marketing.${tabela}`))[0].n, 0, `${tabela}: sem contexto não se enxerga nada`);
      // gravar com a empresa da outra é recusado pela RLS (nada entra)
      await setContext(t, A);
      await sequelize.query('SAVEPOINT rls_forjado', { transaction: t });
      await assert.rejects(() => q(t, `INSERT INTO marketing.${tabela} (id, group_id, company_id) VALUES (gen_random_uuid(), :g, :c)`, { g: B.groupId, c: B.companyId }), (e) => /row-level security/i.test(String(e.message)), `${tabela}: a RLS recusa gravar com a empresa da outra`);
      await sequelize.query('ROLLBACK TO SAVEPOINT rls_forjado', { transaction: t });
      resultado.push(`${tabela}: A=${deA[0].n} B=${deB[0].n}`);
    }
    ctx.diagnostic(`15 tabelas conferidas com 2 empresas: ${resultado.join('; ')}`);
    // nenhuma tabela do schema fica sem RLS FORCE e política (as que as demandas seguintes criaram também)
    const fracas = await q(t, `SELECT c.relname AS tabela FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
      WHERE ns.nspname = 'marketing' AND c.relkind IN ('r','p') AND NOT c.relispartition
        AND (NOT c.relrowsecurity OR NOT c.relforcerowsecurity OR NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid))`);
    assert.deepEqual(fracas, [], 'toda tabela marketing.* tem RLS FORCE e política');
  });
});
