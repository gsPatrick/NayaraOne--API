'use strict';

/**
 * M9-D910 — governance.classification_review_items: a lista de revisão da conversão do vocabulário antigo de classificação (PUBLIC, INTERNAL, CONFIDENTIAL, RESTRICTED) para a
 * escala LOW/MEDIUM/HIGH/RESTRICTED. Valor antigo desconhecido vira HIGH e entra aqui (status OPEN) até um humano decidir (RESOLVED). RLS + FORCE (M9-D800). Reversível.
 */
module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql) => sequelize.query(sql, { transaction });
      await q(`CREATE TABLE IF NOT EXISTS governance.classification_review_items (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        group_id uuid NOT NULL REFERENCES core.groups(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        company_id uuid NOT NULL REFERENCES core.companies(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        table_ref varchar(120) NOT NULL,
        record_id uuid NOT NULL,
        legacy_value varchar(60) NOT NULL,
        converted_value varchar(10) NOT NULL,
        status varchar(10) NOT NULL DEFAULT 'OPEN',
        resolved_by uuid NULL REFERENCES core.users(id) ON UPDATE CASCADE ON DELETE SET NULL,
        resolved_at timestamptz NULL,
        created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT gov_cls_rev_uq UNIQUE (company_id, table_ref, record_id),
        CONSTRAINT gov_cls_rev_status_chk CHECK (status IN ('OPEN', 'RESOLVED')),
        CONSTRAINT gov_cls_rev_value_chk CHECK (converted_value IN ('LOW', 'MEDIUM', 'HIGH', 'RESTRICTED'))
      )`);
      await q("SELECT governance.apply_tenant_rls('governance.classification_review_items'::regclass)");
    });
  },
  async down(queryInterface) {
    await queryInterface.sequelize.query('DROP TABLE IF EXISTS governance.classification_review_items');
  },
};
