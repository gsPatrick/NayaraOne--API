'use strict';

/**
 * M9-D870 — governance.flag_versions: a foto da chave ANTES de cada alteração (versão que deixou de valer), para guardar o valor anterior e permitir
 * conferir o histórico. Uma linha por (chave, versão). RLS + FORCE pela empresa (função do alicerce, GRANT guardado).
 */
module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql) => sequelize.query(sql, { transaction });
      await q(`CREATE TABLE IF NOT EXISTS governance.flag_versions (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        group_id uuid NOT NULL REFERENCES core.groups(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        company_id uuid NOT NULL REFERENCES core.companies(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        entry_kind varchar(8) NOT NULL,
        entry_id uuid NOT NULL,
        key varchar(128) NOT NULL,
        version integer NOT NULL,
        value jsonb NOT NULL,
        scope varchar(12) NOT NULL,
        scope_ref varchar(64) NULL,
        risk varchar(8) NOT NULL,
        owner_user_id uuid NOT NULL,
        valid_from timestamptz NULL,
        valid_until timestamptz NULL,
        state varchar(8) NOT NULL,
        replaced_by uuid NULL,
        replaced_reason text NULL,
        created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT gov_flag_versions_kind_chk CHECK (entry_kind IN ('FLAG','CONFIG')),
        CONSTRAINT gov_flag_versions_entry_version_uq UNIQUE (entry_kind, entry_id, version)
      )`);
      await q('CREATE INDEX IF NOT EXISTS gov_flag_versions_entry_idx ON governance.flag_versions (company_id, entry_id, version DESC)');
      await q("SELECT governance.apply_tenant_rls('governance.flag_versions'::regclass)");
    });
  },
  async down(queryInterface) {
    await queryInterface.sequelize.query('DROP TABLE IF EXISTS governance.flag_versions');
  },
};
