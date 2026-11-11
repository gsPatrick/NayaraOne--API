'use strict';

const { applyLegalTenantRls } = require('./_helpers/legalTenantTable');

/**
 * 1) Caderno M5 DoD "☐ Aditivos/notificações versionados": legal.notice_versions guarda cada versão do conteúdo da
 *    notificação (canal, destinatário, texto, arquivo, SHA-256), append-only (UPDATE/DELETE recusados no banco).
 *    legal.notices ganha current_version e approved_version (a versão revisada/aprovada é a que pode ser enviada).
 *    Legado: cada notificação existente vira a versão 1 com o conteúdo atual.
 * 2) Caderno M5 §14 "Valores a receber ficam estimados e vinculados ao Financeiro somente quando juridicamente
 *    cabível" / "Não confundir estimativa processual com recebível confirmado": legal.case_receivables liga o
 *    processo ao lançamento RECEIVABLE criado a partir do valor CONFIRMADO (nunca do estimado), com a base jurídica
 *    (acordo homologado ou sentença transitada em julgado). Um vínculo por processo; append-only.
 * RLS ENABLE + FORCE, política tenant_isolation, GRANT só SELECT/INSERT ao runtime. Reversível.
 */
const IMMUTABLE_FN = `CREATE OR REPLACE FUNCTION legal.append_only_row() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% é append-only: % não é permitido.', TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME, TG_OP USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql`;

module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql) => sequelize.query(sql, { transaction });
      await q(IMMUTABLE_FN);

      await q(`CREATE TABLE IF NOT EXISTS legal.notice_versions (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        group_id uuid NOT NULL REFERENCES core.groups(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        company_id uuid NOT NULL REFERENCES core.companies(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        notice_id uuid NOT NULL REFERENCES legal.notices(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        version_number integer NOT NULL CHECK (version_number >= 1),
        channel varchar(32) NOT NULL,
        recipient_person_id uuid NULL,
        recipient_description text NULL,
        content text NULL,
        content_file_id uuid NULL REFERENCES people.files(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        content_sha256 varchar(64) NOT NULL,
        drafted_by_ai boolean NOT NULL DEFAULT false,
        reason text NULL,
        created_by uuid NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT notice_versions_number_uq UNIQUE (notice_id, version_number),
        CONSTRAINT notice_versions_content_chk CHECK (content IS NOT NULL OR content_file_id IS NOT NULL)
      )`);
      await q('CREATE INDEX IF NOT EXISTS notice_versions_company_idx ON legal.notice_versions (company_id, notice_id)');
      await q('DROP TRIGGER IF EXISTS notice_versions_append_only ON legal.notice_versions');
      await q('CREATE TRIGGER notice_versions_append_only BEFORE UPDATE OR DELETE ON legal.notice_versions FOR EACH ROW EXECUTE FUNCTION legal.append_only_row()');

      await q(`ALTER TABLE legal.notices
        ADD COLUMN IF NOT EXISTS current_version integer NOT NULL DEFAULT 1,
        ADD COLUMN IF NOT EXISTS approved_version integer NULL`);
      // Backfill do legado sem depender do papel da migration ignorar RLS (mesmo cuidado da migration 460).
      await q('ALTER TABLE legal.notices NO FORCE ROW LEVEL SECURITY');
      await q(`INSERT INTO legal.notice_versions (group_id, company_id, notice_id, version_number, channel, recipient_person_id, recipient_description, content, content_file_id, content_sha256, drafted_by_ai, reason, created_by, created_at)
        SELECT n.group_id, n.company_id, n.id, 1, n.channel, n.recipient_person_id, n.recipient_description, n.content, n.content_file_id,
               encode(sha256(convert_to(COALESCE(n.content, '') || '|' || COALESCE(n.content_file_id::text, ''), 'UTF8')), 'hex'),
               n.drafted_by_ai, 'Versão inicial (migração 9998).', n.created_by, n.created_at
        FROM legal.notices n
        WHERE (n.content IS NOT NULL OR n.content_file_id IS NOT NULL)
          AND NOT EXISTS (SELECT 1 FROM legal.notice_versions v WHERE v.notice_id = n.id)`);
      await q("UPDATE legal.notices SET approved_version = current_version WHERE status IN ('APPROVED', 'SENT', 'DELIVERED') AND approved_version IS NULL");
      await q('ALTER TABLE legal.notices FORCE ROW LEVEL SECURITY');
      await applyLegalTenantRls(q, 'legal.notice_versions', 'SELECT, INSERT');

      await q(`CREATE TABLE IF NOT EXISTS legal.case_receivables (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        group_id uuid NOT NULL REFERENCES core.groups(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        company_id uuid NOT NULL REFERENCES core.companies(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        legal_case_id uuid NOT NULL REFERENCES legal.legal_cases(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        financial_entry_id uuid NOT NULL REFERENCES finance.financial_entries(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        basis varchar(32) NOT NULL CHECK (basis IN ('SETTLEMENT', 'FINAL_JUDGMENT')),
        basis_reference text NOT NULL,
        amount numeric(18,2) NOT NULL CHECK (amount > 0),
        created_by uuid NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT case_receivables_case_uq UNIQUE (legal_case_id),
        CONSTRAINT case_receivables_entry_uq UNIQUE (financial_entry_id)
      )`);
      await q('DROP TRIGGER IF EXISTS case_receivables_append_only ON legal.case_receivables');
      await q('CREATE TRIGGER case_receivables_append_only BEFORE UPDATE OR DELETE ON legal.case_receivables FOR EACH ROW EXECUTE FUNCTION legal.append_only_row()');
      await applyLegalTenantRls(q, 'legal.case_receivables', 'SELECT, INSERT');
    });
  },

  async down(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql) => sequelize.query(sql, { transaction });
      await q('DROP TABLE IF EXISTS legal.case_receivables');
      await q('ALTER TABLE legal.notices DROP COLUMN IF EXISTS approved_version, DROP COLUMN IF EXISTS current_version');
      await q('DROP TABLE IF EXISTS legal.notice_versions');
      await q('DROP FUNCTION IF EXISTS legal.append_only_row()');
    });
  },
};
