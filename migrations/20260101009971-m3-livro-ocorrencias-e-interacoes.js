'use strict';

/**
 * Fechamento do Marco 3 pelo livro (Pessoas/Imóveis/CRM/Radar):
 *  - §15 "Interaction pode abrir service_occurrence": crm.feedback_cases.message_id liga a ocorrência à interação que a
 *    originou (mesma empresa, conferida no service).
 *  - §15 "Não apagar ocorrência para melhorar indicador" / CRM-TS-015 "Complaint delete — Bloqueado/audit": o banco recusa
 *    DELETE e o soft delete (deleted_at) em crm.feedback_cases, para qualquer papel, inclusive o runtime.
 *  - Guia §10 Interaction API (occurredAt): crm.messages.occurred_at guarda quando o contato aconteceu (telefonema ou visita
 *    registrados depois); vazio nas mensagens antigas, que usam created_at.
 * Reversível.
 */
module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql) => sequelize.query(sql, { transaction });
      await q('ALTER TABLE crm.feedback_cases ADD COLUMN IF NOT EXISTS message_id uuid NULL REFERENCES crm.messages(id) ON UPDATE CASCADE ON DELETE RESTRICT');
      await q('CREATE INDEX IF NOT EXISTS crm_feedback_cases_message_id_idx ON crm.feedback_cases (message_id) WHERE message_id IS NOT NULL');
      await q('ALTER TABLE crm.messages ADD COLUMN IF NOT EXISTS occurred_at timestamptz NULL');
      await q(`CREATE OR REPLACE FUNCTION crm.feedback_cases_never_deleted() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF TG_OP = 'DELETE' OR (NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL) THEN
            RAISE EXCEPTION 'FEEDBACK_CASE_DELETE_FORBIDDEN: ocorrência de atendimento não pode ser apagada (livro do Marco 3, §15).'
              USING ERRCODE = 'P0001';
          END IF;
          RETURN NEW;
        END $$`);
      await q('DROP TRIGGER IF EXISTS feedback_cases_no_delete ON crm.feedback_cases');
      await q('CREATE TRIGGER feedback_cases_no_delete BEFORE DELETE ON crm.feedback_cases FOR EACH ROW EXECUTE FUNCTION crm.feedback_cases_never_deleted()');
      await q('DROP TRIGGER IF EXISTS feedback_cases_no_soft_delete ON crm.feedback_cases');
      await q('CREATE TRIGGER feedback_cases_no_soft_delete BEFORE UPDATE OF deleted_at ON crm.feedback_cases FOR EACH ROW EXECUTE FUNCTION crm.feedback_cases_never_deleted()');
    });
  },
  async down(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql) => sequelize.query(sql, { transaction });
      await q('DROP TRIGGER IF EXISTS feedback_cases_no_soft_delete ON crm.feedback_cases');
      await q('DROP TRIGGER IF EXISTS feedback_cases_no_delete ON crm.feedback_cases');
      await q('DROP FUNCTION IF EXISTS crm.feedback_cases_never_deleted()');
      await q('ALTER TABLE crm.messages DROP COLUMN IF EXISTS occurred_at');
      await q('DROP INDEX IF EXISTS crm.crm_feedback_cases_message_id_idx');
      await q('ALTER TABLE crm.feedback_cases DROP COLUMN IF EXISTS message_id');
    });
  },
};
