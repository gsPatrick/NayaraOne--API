'use strict';

/**
 * M9-D015 — ai.cache_entries: cache seguro de resultados não sensíveis da NAY. `key` = SHA-256 de empresa + agente + versão + tarefa +
 * permissões efetivas + pedido normalizado + fontes (o modelo NÃO entra); `scope_key` = o mesmo sem as fontes, por onde o roteador acha a
 * entrada antes de buscar fontes. `source_ids` guarda as fontes usadas ({t, r, v}) para invalidar quando uma muda de versão ou é revogada.
 * provider_code e model_code são só informativos. RLS ENABLE + FORCE por empresa; nunca cache compartilhado entre empresas.
 */
module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql) => sequelize.query(sql, { transaction });
      await q(`CREATE TABLE IF NOT EXISTS ai.cache_entries (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        group_id uuid NOT NULL REFERENCES core.groups(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        company_id uuid NOT NULL REFERENCES core.companies(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        key varchar(64) NOT NULL,
        scope_key varchar(64) NOT NULL,
        agent_code varchar(64) NOT NULL,
        agent_version integer NOT NULL,
        task_type varchar(120) NOT NULL,
        value_json jsonb NOT NULL,
        source_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
        provider_code varchar(64),
        model_code varchar(120),
        created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        expires_at timestamptz NOT NULL,
        CONSTRAINT cache_entries_key_chk CHECK (key ~ '^[0-9a-f]{64}$' AND scope_key ~ '^[0-9a-f]{64}$'),
        CONSTRAINT cache_entries_expiry_chk CHECK (expires_at > created_at),
        CONSTRAINT cache_entries_unique UNIQUE (company_id, key)
      )`);
      await q('CREATE INDEX IF NOT EXISTS ai_cache_entries_scope_idx ON ai.cache_entries (company_id, scope_key, created_at DESC)');
      await q('CREATE INDEX IF NOT EXISTS ai_cache_entries_expiry_idx ON ai.cache_entries (company_id, expires_at)');
      await q('ALTER TABLE ai.cache_entries ENABLE ROW LEVEL SECURITY');
      await q('ALTER TABLE ai.cache_entries FORCE ROW LEVEL SECURITY');
      await q('DROP POLICY IF EXISTS tenant_isolation ON ai.cache_entries');
      await q(`CREATE POLICY tenant_isolation ON ai.cache_entries
        USING (group_id = NULLIF(current_setting('app.group_id', true), '')::uuid
               AND company_id = NULLIF(current_setting('app.company_id', true), '')::uuid)`);
      await q(`DO $$
        BEGIN
          IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nayara_runtime') THEN
            GRANT USAGE ON SCHEMA ai TO nayara_runtime;
            GRANT SELECT, INSERT, UPDATE, DELETE ON ai.cache_entries TO nayara_runtime;
          END IF;
        END $$`);
    });
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query('DROP TABLE IF EXISTS ai.cache_entries');
  },
};
