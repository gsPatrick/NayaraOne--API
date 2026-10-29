'use strict';

/**
 * M9-D017 — ai.service_identities: identidade de serviço da NAY por empresa e agente, usada em tarefa automática (sem usuário).
 *
 * - Só leitura (AI-004): `permissions` é uma lista de códigos cuja ação final é read, view ou list. O banco recusa qualquer outra
 *   (create, update, delete, approve...) pela função ai.permissions_are_read_only e pela CHECK da coluna. A existência do código
 *   em core.permissions é conferida pelo serviço (a tabela de permissões é global e não entra em CHECK).
 * - Uma identidade por (empresa, agente). RLS ENABLE + FORCE por group_id e company_id. GRANT ao nayara_runtime só se o role existir.
 * - Idempotente numa transação; o down remove a tabela e a função.
 */
module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql) => sequelize.query(sql, { transaction });
      await q('CREATE SCHEMA IF NOT EXISTS ai');
      // A ação do código é o último trecho; nos escopos `read:own` e `read:all` é o trecho anterior ao escopo.
      await q(`CREATE OR REPLACE FUNCTION ai.permissions_are_read_only(p jsonb) RETURNS boolean
        LANGUAGE sql IMMUTABLE AS $f$
          SELECT jsonb_typeof(p) = 'array' AND NOT EXISTS (
            SELECT 1 FROM jsonb_array_elements(p) AS e(v)
             WHERE jsonb_typeof(e.v) <> 'string'
                OR (e.v #>> '{}') !~ '^[a-z][a-z0-9_]*(:[a-zA-Z0-9_]+)+$'
                OR (CASE WHEN (e.v #>> '{}') ~ ':(own|all)$'
                         THEN (regexp_match(e.v #>> '{}', '([^:]+):(?:own|all)$'))[1]
                         ELSE (regexp_match(e.v #>> '{}', '[^:]+$'))[1] END) NOT IN ('read', 'view', 'list')
          )
        $f$`);
      await q(`CREATE TABLE IF NOT EXISTS ai.service_identities (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        group_id uuid NOT NULL REFERENCES core.groups(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        company_id uuid NOT NULL REFERENCES core.companies(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        agent_code varchar(60) NOT NULL,
        permissions jsonb NOT NULL DEFAULT '[]'::jsonb,
        enabled boolean NOT NULL DEFAULT true,
        created_by uuid NULL,
        updated_by uuid NULL,
        created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT service_identities_company_agent_uq UNIQUE (company_id, agent_code),
        CONSTRAINT service_identities_code_chk CHECK (agent_code ~ '^[A-Z][A-Z0-9_]{2,59}$'),
        CONSTRAINT service_identities_read_only_chk CHECK (ai.permissions_are_read_only(permissions))
      )`);
      await q('CREATE INDEX IF NOT EXISTS ai_service_identities_group_idx ON ai.service_identities (group_id)');
      await q('ALTER TABLE ai.service_identities ENABLE ROW LEVEL SECURITY');
      await q('ALTER TABLE ai.service_identities FORCE ROW LEVEL SECURITY');
      await q('DROP POLICY IF EXISTS tenant_isolation ON ai.service_identities');
      await q(`CREATE POLICY tenant_isolation ON ai.service_identities
        USING (group_id = NULLIF(current_setting('app.group_id', true), '')::uuid
               AND company_id = NULLIF(current_setting('app.company_id', true), '')::uuid)`);
      await q(`DO $$
        BEGIN
          IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nayara_runtime') THEN
            GRANT USAGE ON SCHEMA ai TO nayara_runtime;
            GRANT SELECT, INSERT, UPDATE ON ai.service_identities TO nayara_runtime;
          END IF;
        END $$`);
    });
  },

  async down(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      await sequelize.query('DROP TABLE IF EXISTS ai.service_identities', { transaction });
      await sequelize.query('DROP FUNCTION IF EXISTS ai.permissions_are_read_only(jsonb)', { transaction });
    });
  },
};
