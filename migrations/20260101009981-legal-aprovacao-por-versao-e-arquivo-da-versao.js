'use strict';

/**
 * Matriz M5 (Caderno §5/§8/§19, Guia §4/§6): aprovação POR VERSÃO e contrato vinculado.
 *  - legal.contract_versions ganha status (DRAFT | APPROVED | SUPERSEDED), approved_by/approved_at,
 *    content_file_id (arquivo armazenado com os bytes que geraram o content_hash) e template_version_id
 *    (a FK para legal.template_versions entra na migration 9982, que cria a tabela).
 *  - legal.contracts ganha approved_version_id (a versão homologada) e parent_contract_id (ADDENDUM,
 *    KEY_DELIVERY e USED_PROPERTY_DELIVERY são vinculados ao contrato principal, Caderno §3).
 *  - O gatilho append-only das versões passa a aceitar SÓ estas mudanças: DRAFT -> APPROVED (uma vez,
 *    com aprovador e data), DRAFT/APPROVED -> SUPERSEDED, e o vínculo único do documento assinado.
 *  - Legado: contratos já em APPROVED ou adiante ficam com a última versão APPROVED (approved_version_id)
 *    e as anteriores SUPERSEDED; o resto fica DRAFT. Reversível.
 */
const GUARD_SQL = `
  CREATE OR REPLACE FUNCTION legal.contract_versions_block_update()
  RETURNS trigger AS $$
  DECLARE
    livres text[] := ARRAY['signed_document_file_id', 'updated_by', 'updated_at', 'status', 'approved_by', 'approved_at'];
  BEGIN
    IF (to_jsonb(NEW) - livres) IS DISTINCT FROM (to_jsonb(OLD) - livres) THEN
      RAISE EXCEPTION 'legal.contract_versions é append-only: UPDATE não é permitido (versão %, contrato %).',
        OLD.version_number, OLD.contract_id USING ERRCODE = '42501';
    END IF;
    IF NEW.signed_document_file_id IS DISTINCT FROM OLD.signed_document_file_id
       AND (OLD.signed_document_file_id IS NOT NULL OR NEW.signed_document_file_id IS NULL) THEN
      RAISE EXCEPTION 'legal.contract_versions: o documento assinado só pode ser vinculado uma vez e nunca trocado/removido (versão %, contrato %).',
        OLD.version_number, OLD.contract_id USING ERRCODE = '42501';
    END IF;
    IF NEW.status IS DISTINCT FROM OLD.status
       OR NEW.approved_by IS DISTINCT FROM OLD.approved_by
       OR NEW.approved_at IS DISTINCT FROM OLD.approved_at THEN
      IF NOT (
        (OLD.status = 'DRAFT' AND NEW.status = 'APPROVED' AND OLD.approved_by IS NULL AND OLD.approved_at IS NULL
           AND NEW.approved_by IS NOT NULL AND NEW.approved_at IS NOT NULL)
        OR (OLD.status IN ('DRAFT', 'APPROVED') AND NEW.status = 'SUPERSEDED'
           AND NEW.approved_by IS NOT DISTINCT FROM OLD.approved_by AND NEW.approved_at IS NOT DISTINCT FROM OLD.approved_at)
      ) THEN
        RAISE EXCEPTION 'legal.contract_versions: a versão % do contrato % só pode ir de DRAFT para APPROVED (uma vez, com aprovador) ou para SUPERSEDED.',
          OLD.version_number, OLD.contract_id USING ERRCODE = '42501';
      END IF;
    END IF;
    RETURN NEW;
  END;
  $$ LANGUAGE plpgsql;
`;

const OLD_GUARD_SQL = `
  CREATE OR REPLACE FUNCTION legal.contract_versions_block_update()
  RETURNS trigger AS $$
  BEGIN
    IF (to_jsonb(NEW) - ARRAY['signed_document_file_id', 'updated_by', 'updated_at'])
       IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['signed_document_file_id', 'updated_by', 'updated_at']) THEN
      RAISE EXCEPTION 'legal.contract_versions é append-only: UPDATE não é permitido (versão %, contrato %).',
        OLD.version_number, OLD.contract_id USING ERRCODE = '42501';
    END IF;
    IF NEW.signed_document_file_id IS DISTINCT FROM OLD.signed_document_file_id
       AND (OLD.signed_document_file_id IS NOT NULL OR NEW.signed_document_file_id IS NULL) THEN
      RAISE EXCEPTION 'legal.contract_versions: o documento assinado só pode ser vinculado uma vez e nunca trocado/removido (versão %, contrato %).',
        OLD.version_number, OLD.contract_id USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END;
  $$ LANGUAGE plpgsql;
`;

const APPROVED_OR_LATER = "('APPROVED','SIGNING','SIGNED','ACTIVE','SUSPENDED','TERMINATED','CLOSED')";

module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql) => sequelize.query(sql, { transaction });
      await q(`ALTER TABLE legal.contract_versions
        ADD COLUMN IF NOT EXISTS status varchar(16) NOT NULL DEFAULT 'DRAFT',
        ADD COLUMN IF NOT EXISTS approved_by uuid NULL REFERENCES core.users(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        ADD COLUMN IF NOT EXISTS approved_at timestamptz NULL,
        ADD COLUMN IF NOT EXISTS content_file_id uuid NULL REFERENCES people.files(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        ADD COLUMN IF NOT EXISTS template_version_id uuid NULL`);
      await q(`DO $c$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'contract_versions_status_chk') THEN
          ALTER TABLE legal.contract_versions ADD CONSTRAINT contract_versions_status_chk CHECK (status IN ('DRAFT','APPROVED','SUPERSEDED'));
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'contract_versions_approval_chk') THEN
          ALTER TABLE legal.contract_versions ADD CONSTRAINT contract_versions_approval_chk CHECK (status <> 'APPROVED' OR approved_at IS NOT NULL);
        END IF;
      END $c$`);
      await q(`ALTER TABLE legal.contracts
        ADD COLUMN IF NOT EXISTS approved_version_id uuid NULL REFERENCES legal.contract_versions(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        ADD COLUMN IF NOT EXISTS parent_contract_id uuid NULL REFERENCES legal.contracts(id) ON UPDATE CASCADE ON DELETE RESTRICT`);
      await q('CREATE INDEX IF NOT EXISTS contracts_parent_idx ON legal.contracts (company_id, parent_contract_id) WHERE parent_contract_id IS NOT NULL');

      // Legado (o gatilho append-only fica desligado só durante o acerto de dados desta migration).
      await q('ALTER TABLE legal.contract_versions DISABLE TRIGGER contract_versions_append_only');
      const ultima = 'SELECT DISTINCT ON (contract_id) id FROM legal.contract_versions ORDER BY contract_id, version_number DESC';
      await q(`UPDATE legal.contract_versions v SET status = 'APPROVED', approved_at = v.updated_at
          FROM legal.contracts c WHERE v.contract_id = c.id AND c.status IN ${APPROVED_OR_LATER} AND v.id IN (${ultima})`);
      await q(`UPDATE legal.contract_versions SET status = 'SUPERSEDED' WHERE id NOT IN (${ultima})`);
      await q(`UPDATE legal.contracts c SET approved_version_id = v.id
          FROM legal.contract_versions v
         WHERE v.contract_id = c.id AND v.status = 'APPROVED' AND c.approved_version_id IS NULL`);
      await q('ALTER TABLE legal.contract_versions ENABLE TRIGGER contract_versions_append_only');
      await q(GUARD_SQL);
    });
  },

  async down(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql) => sequelize.query(sql, { transaction });
      await q(OLD_GUARD_SQL);
      await q('DROP INDEX IF EXISTS legal.contracts_parent_idx');
      await q('ALTER TABLE legal.contracts DROP COLUMN IF EXISTS approved_version_id, DROP COLUMN IF EXISTS parent_contract_id');
      await q('ALTER TABLE legal.contract_versions DISABLE TRIGGER contract_versions_append_only');
      await q(`ALTER TABLE legal.contract_versions DROP CONSTRAINT IF EXISTS contract_versions_status_chk, DROP CONSTRAINT IF EXISTS contract_versions_approval_chk,
        DROP COLUMN IF EXISTS status, DROP COLUMN IF EXISTS approved_by, DROP COLUMN IF EXISTS approved_at,
        DROP COLUMN IF EXISTS content_file_id, DROP COLUMN IF EXISTS template_version_id`);
      await q('ALTER TABLE legal.contract_versions ENABLE TRIGGER contract_versions_append_only');
    });
  },
};
