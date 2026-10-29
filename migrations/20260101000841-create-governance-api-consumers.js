'use strict';

/**
 * M9-D841 — governance.api_consumers: o catálogo de consumidores da API (M9-D841 §3.1). Cada linha é um app, provedor, parceiro ou serviço interno que chama a API: `owner_user_id`
 * é OBRIGATÓRIO, `api_version_used` é a major (1, 2...), `client_id` liga ao cadastro de credencial externa (M9-D844) e `app_key` é o valor do cabeçalho X-Client-App dos consumidores
 * INTERNAL/APP semeados (o front web). RLS + FORCE pela função do alicerce (M9-D800). Uma segunda política (`api_consumer_client_lookup`, só SELECT, só com `app.api_client_lookup = 'on'`)
 * deixa o middleware de API achar o consumidor de uma credencial externa pelo client_id antes de saber a empresa; ninguém mais liga essa chave. Reversível.
 */
module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql) => sequelize.query(sql, { transaction });
      await q(`CREATE TABLE IF NOT EXISTS governance.api_consumers (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        group_id uuid NOT NULL REFERENCES core.groups(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        company_id uuid NOT NULL REFERENCES core.companies(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        name varchar(120) NOT NULL,
        kind varchar(10) NOT NULL,
        owner_user_id uuid NOT NULL REFERENCES core.users(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        contact_email varchar(254) NULL,
        api_version_used integer NOT NULL DEFAULT 1,
        client_id varchar(80) NULL,
        app_key varchar(60) NULL,
        last_seen_at timestamptz NULL,
        status varchar(10) NOT NULL DEFAULT 'ACTIVE',
        created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT gov_api_consumer_kind_chk CHECK (kind IN ('APP', 'PROVIDER', 'PARTNER', 'INTERNAL')),
        CONSTRAINT gov_api_consumer_status_chk CHECK (status IN ('ACTIVE', 'SUSPENDED', 'RETIRED')),
        CONSTRAINT gov_api_consumer_version_chk CHECK (api_version_used >= 1),
        CONSTRAINT gov_api_consumer_name_chk CHECK (length(btrim(name)) > 0)
      )`);
      await q('CREATE UNIQUE INDEX IF NOT EXISTS gov_api_consumer_name_uq ON governance.api_consumers (company_id, lower(name))');
      await q('CREATE UNIQUE INDEX IF NOT EXISTS gov_api_consumer_client_uq ON governance.api_consumers (client_id) WHERE client_id IS NOT NULL');
      await q('CREATE UNIQUE INDEX IF NOT EXISTS gov_api_consumer_app_uq ON governance.api_consumers (company_id, app_key) WHERE app_key IS NOT NULL');
      await q('CREATE INDEX IF NOT EXISTS gov_api_consumer_list_idx ON governance.api_consumers (company_id, status, kind)');
      await q("SELECT governance.apply_tenant_rls('governance.api_consumers'::regclass)");
      await q(`DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'governance.api_consumers'::regclass AND polname = 'api_consumer_client_lookup') THEN
          CREATE POLICY api_consumer_client_lookup ON governance.api_consumers FOR SELECT
            USING (current_setting('app.api_client_lookup', true) = 'on' AND client_id IS NOT NULL);
        END IF;
      END $$`);
    });
  },
  async down(queryInterface) {
    await queryInterface.sequelize.query('DROP TABLE IF EXISTS governance.api_consumers CASCADE');
  },
};
