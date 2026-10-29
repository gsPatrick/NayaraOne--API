'use strict';

/**
 * M9-D824 — governance.access_signals: cada leitura de recurso HIGH/RESTRICTED, cada pedido de exportação (aprovado ou bloqueado) e cada cópia (permitida ou negada)
 * vira uma linha, com `count` itens, para o detector de anomalia de acesso em massa somar numa janela deslizante. É por empresa (RLS + FORCE pela função do alicerce
 * M9-D800, GRANT ao role de runtime com guarda de existência). Reversível.
 */
module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql) => sequelize.query(sql, { transaction });
      await q(`CREATE TABLE IF NOT EXISTS governance.access_signals (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        group_id uuid NOT NULL REFERENCES core.groups(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        company_id uuid NOT NULL REFERENCES core.companies(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        user_id uuid NOT NULL REFERENCES core.users(id) ON UPDATE CASCADE ON DELETE CASCADE,
        kind varchar(8) NOT NULL,
        action varchar(8) NOT NULL,
        classification varchar(12) NOT NULL,
        outcome varchar(8) NOT NULL,
        resource_type varchar(80) NULL,
        count integer NOT NULL DEFAULT 1,
        occurred_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT gov_accsig_kind_chk CHECK (kind IN ('READ', 'EXPORT', 'COPY')),
        CONSTRAINT gov_accsig_action_chk CHECK (action IN ('VIEW', 'COPY', 'EXPORT', 'PRINT', 'SHARE', 'AI')),
        CONSTRAINT gov_accsig_class_chk CHECK (classification IN ('LOW', 'MEDIUM', 'HIGH', 'RESTRICTED')),
        CONSTRAINT gov_accsig_outcome_chk CHECK (outcome IN ('ALLOWED', 'DENIED')),
        CONSTRAINT gov_accsig_count_chk CHECK (count >= 1)
      )`);
      await q('CREATE INDEX IF NOT EXISTS gov_accsig_window_idx ON governance.access_signals (company_id, user_id, kind, occurred_at DESC)');
      await q("SELECT governance.apply_tenant_rls('governance.access_signals'::regclass)");
    });
  },
  async down(queryInterface) {
    await queryInterface.sequelize.query('DROP TABLE IF EXISTS governance.access_signals');
  },
};
