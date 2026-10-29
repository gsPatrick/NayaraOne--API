'use strict';

/**
 * M9-D841 — governance.api_deprecations: a deprecação anunciada de uma rota ou de uma major da API (M9-D841 §3.2). `target` = `ROUTE:<MÉTODO> <caminho>` ou `MAJOR:<n>`; `owner_user_id`
 * e `sunset_at` são OBRIGATÓRIOS (livro: "deprecation exige owner e prazo") e `sunset_at` é posterior a `announced_at`. `replacement` é a URL relativa da rota ou major substituta. Uma só
 * deprecação aberta (ANNOUNCED ou SUNSET) por alvo e empresa. RLS + FORCE pela função do alicerce (M9-D800). Reversível.
 */
module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql) => sequelize.query(sql, { transaction });
      await q(`CREATE TABLE IF NOT EXISTS governance.api_deprecations (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        group_id uuid NOT NULL REFERENCES core.groups(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        company_id uuid NOT NULL REFERENCES core.companies(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        target varchar(300) NOT NULL,
        announced_at timestamptz NOT NULL DEFAULT now(),
        sunset_at timestamptz NOT NULL,
        owner_user_id uuid NOT NULL REFERENCES core.users(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        replacement varchar(300) NULL,
        replacement_note text NULL,
        status varchar(10) NOT NULL DEFAULT 'ANNOUNCED',
        created_by uuid NULL REFERENCES core.users(id) ON UPDATE CASCADE ON DELETE SET NULL,
        created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT gov_api_deprecation_status_chk CHECK (status IN ('ANNOUNCED', 'SUNSET', 'CANCELLED')),
        CONSTRAINT gov_api_deprecation_dates_chk CHECK (sunset_at > announced_at),
        CONSTRAINT gov_api_deprecation_target_chk CHECK (target ~ '^(ROUTE:[A-Z]+ /.*|MAJOR:[0-9]+)$')
      )`);
      await q("CREATE UNIQUE INDEX IF NOT EXISTS gov_api_deprecation_open_uq ON governance.api_deprecations (company_id, target) WHERE status IN ('ANNOUNCED', 'SUNSET')");
      await q('CREATE INDEX IF NOT EXISTS gov_api_deprecation_list_idx ON governance.api_deprecations (company_id, status, sunset_at)');
      await q("SELECT governance.apply_tenant_rls('governance.api_deprecations'::regclass)");
    });
  },
  async down(queryInterface) {
    await queryInterface.sequelize.query('DROP TABLE IF EXISTS governance.api_deprecations');
  },
};
