'use strict';

/**
 * M9-D905 — governance.mig_entity_schema: a ordem e o tipo dos campos de cada entidade na serialização canônica do lote (text, int, money, decimal com escala, bool, instant,
 * date). A semente (PERSON, SUPPLIER, PROPERTY) é gravada por empresa quando o primeiro lote é aplicado; entidade sem linhas aqui e sem semente é recusada com 422
 * GOV_MIG_SCHEMA_MISSING. RLS + FORCE pela função do alicerce. Reversível.
 */
module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql) => sequelize.query(sql, { transaction });
      await q(`CREATE TABLE IF NOT EXISTS governance.mig_entity_schema (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        group_id uuid NOT NULL REFERENCES core.groups(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        company_id uuid NOT NULL REFERENCES core.companies(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        entity varchar(30) NOT NULL,
        position integer NOT NULL,
        field varchar(60) NOT NULL,
        type varchar(10) NOT NULL,
        scale integer NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT mig_entity_schema_type_chk CHECK (type IN ('text', 'int', 'money', 'decimal', 'bool', 'instant', 'date')),
        CONSTRAINT mig_entity_schema_scale_chk CHECK ((type = 'decimal') = (scale IS NOT NULL))
      )`);
      await q('CREATE UNIQUE INDEX IF NOT EXISTS mig_entity_schema_field_uq ON governance.mig_entity_schema (company_id, entity, field)');
      await q('CREATE UNIQUE INDEX IF NOT EXISTS mig_entity_schema_position_uq ON governance.mig_entity_schema (company_id, entity, position)');
      await q("SELECT governance.apply_tenant_rls('governance.mig_entity_schema'::regclass)");
    });
  },
  async down(queryInterface) {
    await queryInterface.sequelize.query('DROP TABLE IF EXISTS governance.mig_entity_schema');
  },
};
