'use strict';

/**
 * M9-D844 — governance.api_clients: as credenciais da API externa (M9-D844 §3.1). `client_id` é público e único; `secret_hash` guarda SÓ o hash bcrypt do segredo (o segredo em claro
 * aparece uma vez, na criação); `scopes` são códigos de governance.api_scopes; `status` é ACTIVE ou REVOKED (não existe rotação: revoga-se e cria-se outra). Cada credencial tem o seu
 * consumidor (M9-D841, consumer_id). RLS + FORCE pela função do alicerce (M9-D800). Uma segunda política (`api_client_lookup`, só SELECT, só com `app.api_client_lookup = 'on'`) deixa o
 * endpoint de token e o middleware de cliente achar a credencial pelo client_id antes de saber a empresa; ninguém mais liga essa chave. Reversível.
 */
module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql) => sequelize.query(sql, { transaction });
      await q(`CREATE TABLE IF NOT EXISTS governance.api_clients (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        group_id uuid NOT NULL REFERENCES core.groups(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        company_id uuid NOT NULL REFERENCES core.companies(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        consumer_id uuid NOT NULL REFERENCES governance.api_consumers(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        name varchar(120) NOT NULL,
        client_id varchar(80) NOT NULL,
        secret_hash varchar(100) NOT NULL,
        scopes text[] NOT NULL,
        status varchar(10) NOT NULL DEFAULT 'ACTIVE',
        created_by uuid NOT NULL REFERENCES core.users(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        revoked_by uuid NULL REFERENCES core.users(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        revoked_at timestamptz NULL,
        created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT gov_api_client_status_chk CHECK (status IN ('ACTIVE', 'REVOKED')),
        CONSTRAINT gov_api_client_scopes_chk CHECK (cardinality(scopes) >= 1),
        CONSTRAINT gov_api_client_revoked_chk CHECK ((status = 'REVOKED') = (revoked_at IS NOT NULL))
      )`);
      await q('CREATE UNIQUE INDEX IF NOT EXISTS gov_api_client_id_uq ON governance.api_clients (client_id)');
      await q('CREATE UNIQUE INDEX IF NOT EXISTS gov_api_client_consumer_uq ON governance.api_clients (consumer_id)');
      await q('CREATE INDEX IF NOT EXISTS gov_api_client_list_idx ON governance.api_clients (company_id, status, created_at DESC)');
      await q("SELECT governance.apply_tenant_rls('governance.api_clients'::regclass)");
      await q(`DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'governance.api_clients'::regclass AND polname = 'api_client_lookup') THEN
          CREATE POLICY api_client_lookup ON governance.api_clients FOR SELECT USING (current_setting('app.api_client_lookup', true) = 'on');
        END IF;
      END $$`);
    });
  },
  async down(queryInterface) {
    await queryInterface.sequelize.query('DROP TABLE IF EXISTS governance.api_clients CASCADE');
  },
};
