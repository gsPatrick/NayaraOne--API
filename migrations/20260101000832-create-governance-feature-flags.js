'use strict';

/**
 * M9-D870 — governance.feature_flags: o registro das flags booleanas (kind FLAG) do registro de flags e configurações. Toda chave tem responsável (owner_user_id), escopo, risco, versão (começa em 1 e sobe a cada
 * alteração), validade (valid_from/valid_until) e auditoria. A chave é única por empresa, escopo e referência de escopo. RLS + FORCE pela empresa (função do alicerce, GRANT guardado).
 */
module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql) => sequelize.query(sql, { transaction });
      await q(`CREATE TABLE IF NOT EXISTS governance.feature_flags (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        group_id uuid NOT NULL REFERENCES core.groups(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        company_id uuid NOT NULL REFERENCES core.companies(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        key varchar(128) NOT NULL,
        kind varchar(8) NOT NULL DEFAULT 'FLAG',
        value jsonb NOT NULL,
        value_type varchar(8) NOT NULL,
        allowed_values jsonb NULL,
        owner_user_id uuid NOT NULL,
        scope varchar(12) NOT NULL DEFAULT 'GLOBAL',
        scope_ref varchar(64) NULL,
        risk varchar(8) NOT NULL DEFAULT 'MEDIUM',
        version integer NOT NULL DEFAULT 1,
        valid_from timestamptz NULL,
        valid_until timestamptz NULL,
        temporary boolean NOT NULL DEFAULT false,
        description text NULL,
        is_kill_switch boolean NOT NULL DEFAULT false,
        state varchar(8) NOT NULL DEFAULT 'ACTIVE',
        source varchar(16) NOT NULL DEFAULT 'REGISTRY',
        updated_by uuid NULL,
        created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT gov_feature_flags_kind_chk CHECK (kind = 'FLAG'),
        CONSTRAINT gov_feature_flags_value_type_chk CHECK (value_type IN ('BOOLEAN','INTEGER','DECIMAL','STRING','ENUM','JSON')),
        CONSTRAINT gov_feature_flags_scope_chk CHECK (scope IN ('GLOBAL','GROUP','COMPANY','ENVIRONMENT','SECTOR','USER')),
        CONSTRAINT gov_feature_flags_scope_ref_chk CHECK ((scope = 'GLOBAL' AND scope_ref IS NULL) OR (scope <> 'GLOBAL' AND scope_ref IS NOT NULL)),
        CONSTRAINT gov_feature_flags_risk_chk CHECK (risk IN ('LOW','MEDIUM','HIGH','CRITICAL')),
        CONSTRAINT gov_feature_flags_state_chk CHECK (state IN ('ACTIVE','EXPIRED')),
        CONSTRAINT gov_feature_flags_source_chk CHECK (source IN ('REGISTRY','TENANT_SETTING')),
        CONSTRAINT gov_feature_flags_version_chk CHECK (version >= 1),
        CONSTRAINT gov_feature_flags_validity_chk CHECK (valid_from IS NULL OR valid_until IS NULL OR valid_until > valid_from)
      )`);
      await q("CREATE UNIQUE INDEX IF NOT EXISTS gov_feature_flags_key_scope_uq ON governance.feature_flags (company_id, key, scope, COALESCE(scope_ref, ''))");
      await q('CREATE INDEX IF NOT EXISTS gov_feature_flags_company_key_idx ON governance.feature_flags (company_id, key)');
      await q("SELECT governance.apply_tenant_rls('governance.feature_flags'::regclass)");
    });
  },
  async down(queryInterface) {
    await queryInterface.sequelize.query('DROP TABLE IF EXISTS governance.feature_flags');
  },
};
