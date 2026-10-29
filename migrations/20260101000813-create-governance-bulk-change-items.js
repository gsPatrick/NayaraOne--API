'use strict';

/**
 * M9-D808 — governance.bulk_change_items: um item por registro alterado pelo lote. Guarda só o HASH do valor anterior e do novo de cada campo (o claro
 * fica na auditoria individual, ligada por audit_log_id; mesmo critério da M9-D807). `record_type` diz o que mudou: PERSON, PROPERTY, BANK_ACCOUNT ou
 * REVIEW_ITEM (troca de curador na fila). Imutável depois de gravado. RLS + FORCE pela função do alicerce (M9-D800). Reversível.
 */
module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql) => sequelize.query(sql, { transaction });
      await q(`CREATE TABLE IF NOT EXISTS governance.bulk_change_items (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        group_id uuid NOT NULL REFERENCES core.groups(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        company_id uuid NOT NULL REFERENCES core.companies(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        bulk_change_id uuid NOT NULL REFERENCES governance.bulk_changes(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        record_type varchar(20) NOT NULL,
        record_id uuid NOT NULL,
        field_hashes jsonb NOT NULL,
        audit_log_id uuid NULL,
        created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT gov_bulk_items_type_chk CHECK (record_type IN ('PERSON', 'PROPERTY', 'BANK_ACCOUNT', 'REVIEW_ITEM'))
      )`);
      await q('CREATE INDEX IF NOT EXISTS gov_bulk_items_lot_idx ON governance.bulk_change_items (bulk_change_id, created_at, id)');
      await q("SELECT governance.apply_tenant_rls('governance.bulk_change_items'::regclass)");
      await q(`CREATE OR REPLACE FUNCTION governance.bulk_change_items_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'governance.bulk_change_items é imutável.' USING ERRCODE = '23514'; END $$`);
      await q('DROP TRIGGER IF EXISTS bulk_change_items_immutable ON governance.bulk_change_items');
      await q(`CREATE TRIGGER bulk_change_items_immutable BEFORE UPDATE OR DELETE ON governance.bulk_change_items
        FOR EACH ROW EXECUTE FUNCTION governance.bulk_change_items_immutable()`);
    });
  },
  async down(queryInterface) {
    await queryInterface.sequelize.query('DROP TABLE IF EXISTS governance.bulk_change_items');
    await queryInterface.sequelize.query('DROP FUNCTION IF EXISTS governance.bulk_change_items_immutable()');
  },
};
