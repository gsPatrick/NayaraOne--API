'use strict';

/**
 * M9-D807 — governance.field_change_evidence: a origem (source) e o comprovante (evidence_file_id) de cada alteração de campo crítico de
 * pessoas, imóveis e fornecedores. Guarda só o hash (HMAC) do valor antes e depois: o valor em claro fica na auditoria existente
 * (audit.audit_log, ligada por audit_log_id), nunca duplicado aqui. Registro de prova: um gatilho recusa UPDATE e DELETE.
 * RLS + FORCE pela função do alicerce (M9-D800). Reversível.
 */
module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql) => sequelize.query(sql, { transaction });
      await q(`CREATE TABLE IF NOT EXISTS governance.field_change_evidence (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        group_id uuid NOT NULL REFERENCES core.groups(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        company_id uuid NOT NULL REFERENCES core.companies(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        entity_type varchar(30) NOT NULL,
        entity_id uuid NOT NULL,
        field varchar(80) NOT NULL,
        value_before_hash varchar(64) NULL,
        value_after_hash varchar(64) NULL,
        source varchar(20) NOT NULL,
        evidence_file_id uuid NULL REFERENCES people.files(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        note text NULL,
        actor_user_id uuid NULL REFERENCES core.users(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        changed_at timestamptz NOT NULL DEFAULT now(),
        audit_log_id uuid NULL,
        CONSTRAINT gov_field_evidence_source_chk CHECK (source IN ('DOCUMENT', 'PERSON_STATEMENT', 'OFFICIAL_REGISTRY', 'SYSTEM_IMPORT', 'OTHER')),
        CONSTRAINT gov_field_evidence_hash_chk CHECK ((value_before_hash IS NULL OR value_before_hash ~ '^[0-9a-f]{64}$') AND (value_after_hash IS NULL OR value_after_hash ~ '^[0-9a-f]{64}$'))
      )`);
      await q('CREATE INDEX IF NOT EXISTS gov_field_evidence_entity_idx ON governance.field_change_evidence (company_id, entity_type, entity_id, changed_at DESC)');
      await q('CREATE INDEX IF NOT EXISTS gov_field_evidence_file_idx ON governance.field_change_evidence (evidence_file_id) WHERE evidence_file_id IS NOT NULL');
      await q("SELECT governance.apply_tenant_rls('governance.field_change_evidence'::regclass)");
      await q(`CREATE OR REPLACE FUNCTION governance.refuse_evidence_change() RETURNS trigger LANGUAGE plpgsql AS $fn$
        BEGIN RAISE EXCEPTION 'O registro de evidência de alteração não pode ser alterado nem apagado.' USING ERRCODE = '23001'; END $fn$`);
      await q('DROP TRIGGER IF EXISTS gov_field_evidence_immutable ON governance.field_change_evidence');
      await q('CREATE TRIGGER gov_field_evidence_immutable BEFORE UPDATE OR DELETE ON governance.field_change_evidence FOR EACH ROW EXECUTE FUNCTION governance.refuse_evidence_change()');
    });
  },
  async down(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      await sequelize.query('DROP TABLE IF EXISTS governance.field_change_evidence', { transaction });
      await sequelize.query('DROP FUNCTION IF EXISTS governance.refuse_evidence_change()', { transaction });
    });
  },
};
