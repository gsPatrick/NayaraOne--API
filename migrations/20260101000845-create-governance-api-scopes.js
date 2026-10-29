'use strict';

/**
 * M9-D844 — governance.api_scopes: o catálogo FECHADO de scopes da API externa (M9-D844 §3.3), no formato `<recurso>:<ação>` e separado das permissões internas. É catálogo do sistema,
 * igual para toda empresa (sem company_id): RLS + FORCE com leitura aberta e escrita só quando a transação liga `app.api_scope_catalog = 'on'`, o que só esta migration faz. O role de
 * runtime recebe SÓ leitura: scope novo entra por uma migration nova do catálogo, nunca pela aplicação. Semeia properties:read, leads:write e contracts:read. Reversível.
 */
const SCOPES = [
  ['properties:read', 'properties', 'read', 'Consultar os imóveis publicados da empresa.'],
  ['leads:write', 'leads', 'write', 'Enviar um lead (pessoa interessada) para o funil comercial da empresa.'],
  ['contracts:read', 'contracts', 'read', 'Consultar os contratos da empresa (dados resumidos, sem partes nem valores sigilosos).'],
];

module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql, replacements) => sequelize.query(sql, { transaction, replacements });
      await q(`CREATE TABLE IF NOT EXISTS governance.api_scopes (
        code varchar(60) PRIMARY KEY,
        resource varchar(40) NOT NULL,
        action varchar(20) NOT NULL,
        description_pt text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT gov_api_scope_format_chk CHECK (code ~ '^[a-z][a-z0-9-]*:[a-z][a-z0-9-]*$' AND code = resource || ':' || action)
      )`);
      await q('ALTER TABLE governance.api_scopes ENABLE ROW LEVEL SECURITY');
      await q('ALTER TABLE governance.api_scopes FORCE ROW LEVEL SECURITY');
      await q(`DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'governance.api_scopes'::regclass AND polname = 'api_scopes_read') THEN
          CREATE POLICY api_scopes_read ON governance.api_scopes FOR SELECT USING (true);
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'governance.api_scopes'::regclass AND polname = 'api_scopes_catalog_write') THEN
          CREATE POLICY api_scopes_catalog_write ON governance.api_scopes FOR ALL USING (current_setting('app.api_scope_catalog', true) = 'on') WITH CHECK (current_setting('app.api_scope_catalog', true) = 'on');
        END IF;
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nayara_runtime') THEN
          GRANT SELECT ON governance.api_scopes TO nayara_runtime;
        END IF;
      END $$`);
      await q("SELECT set_config('app.api_scope_catalog', 'on', true)");
      for (const [code, resource, action, description] of SCOPES) {
        await q('INSERT INTO governance.api_scopes (code, resource, action, description_pt) VALUES (:code, :resource, :action, :description) ON CONFLICT (code) DO NOTHING', { code, resource, action, description });
      }
    });
  },
  async down(queryInterface) {
    await queryInterface.sequelize.query('DROP TABLE IF EXISTS governance.api_scopes');
  },
};
