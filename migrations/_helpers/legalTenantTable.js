'use strict';

/**
 * RLS do schema legal (mesmo padrão das tabelas legal.* existentes, ex.: migration 666): ENABLE + FORCE,
 * política tenant_isolation por company_id e GRANT ao runtime dentro da guarda de existência do papel.
 * (governance.apply_tenant_rls só aceita tabelas do schema governance.)
 */
async function applyLegalTenantRls(q, table, grants = 'SELECT, INSERT, UPDATE') {
  await q(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
  await q(`DO $p$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polname = 'tenant_isolation' AND polrelid = '${table}'::regclass) THEN
      CREATE POLICY tenant_isolation ON ${table}
        USING (company_id = NULLIF(current_setting('app.company_id', true), '')::uuid)
        WITH CHECK (company_id = NULLIF(current_setting('app.company_id', true), '')::uuid);
    END IF;
  END $p$`);
  await q(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`);
  await q(`DO $g$ BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nayara_runtime') THEN
      GRANT ${grants} ON ${table} TO nayara_runtime;
    END IF;
  END $g$`);
}

module.exports = { applyLegalTenantRls };
