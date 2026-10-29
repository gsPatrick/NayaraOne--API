'use strict';

/**
 * M9-D843 — governance.error_catalog: o catálogo de códigos de erro da API (M9-D843 §3.4): `code` único, `http_status`, `message_pt`, `module`, `since_version`, `deprecated`.
 * É catálogo do sistema, igual para toda empresa (sem company_id): RLS + FORCE com leitura aberta e escrita só quando a transação liga `app.error_catalog_sync = 'on'` (a sincronização
 * do boot a partir de errorCatalog.data.json, o mesmo arquivo que gera docs/ERROR_CODES.md). Semeada aqui com o arquivo atual. GRANT ao role de runtime só se ele existir. Reversível.
 */
const { entriesFromData } = require('../src/features/core-governance/api-governance/standards/errorCatalog.data');

module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql, replacements) => sequelize.query(sql, { transaction, replacements });
      await q(`CREATE TABLE IF NOT EXISTS governance.error_catalog (
        code varchar(100) PRIMARY KEY,
        http_status smallint NOT NULL,
        message_pt text NOT NULL,
        module varchar(40) NOT NULL,
        since_version varchar(20) NOT NULL,
        deprecated boolean NOT NULL DEFAULT false,
        created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT gov_error_catalog_status_chk CHECK (http_status BETWEEN 100 AND 599)
      )`);
      for (const e of entriesFromData()) {
        await q(`INSERT INTO governance.error_catalog (code, http_status, message_pt, module, since_version, deprecated)
          VALUES (:code, :status, :message, :module, :since, :deprecated) ON CONFLICT (code) DO NOTHING`, { code: e.code, status: e.status, message: e.message, module: e.module, since: e.since, deprecated: e.deprecated });
      }
      await q('ALTER TABLE governance.error_catalog ENABLE ROW LEVEL SECURITY');
      await q('ALTER TABLE governance.error_catalog FORCE ROW LEVEL SECURITY');
      await q(`DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'governance.error_catalog'::regclass AND polname = 'error_catalog_read') THEN
          CREATE POLICY error_catalog_read ON governance.error_catalog FOR SELECT USING (true);
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'governance.error_catalog'::regclass AND polname = 'error_catalog_sync') THEN
          CREATE POLICY error_catalog_sync ON governance.error_catalog FOR ALL USING (current_setting('app.error_catalog_sync', true) = 'on') WITH CHECK (current_setting('app.error_catalog_sync', true) = 'on');
        END IF;
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nayara_runtime') THEN
          GRANT SELECT, INSERT, UPDATE, DELETE ON governance.error_catalog TO nayara_runtime;
        END IF;
      END $$`);
    });
  },
  async down(queryInterface) {
    await queryInterface.sequelize.query('DROP TABLE IF EXISTS governance.error_catalog');
  },
};
