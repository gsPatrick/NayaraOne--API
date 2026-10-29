'use strict';

/**
 * M9-D416 — finalidade da mensagem automática em crm.messages.
 *
 * O frequency cap conta as mensagens OUTBOUND automáticas por pessoa, canal e finalidade (MKT-014). Quem envia grava a finalidade
 * (MARKETING, NUTRICAO, TRANSACTIONAL...) na própria mensagem; coluna nula = mensagem que não veio de automação ou campanha
 * (todas as existentes), que nunca entra na conta do cap. O índice parcial atende a contagem da janela móvel. RLS, FORCE e GRANTs
 * da tabela não mudam (coluna nova herda os privilégios).
 *
 * Idempotente (IF NOT EXISTS), numa transação. O down remove índice e coluna.
 */
module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql) => sequelize.query(sql, { transaction });
      await q('ALTER TABLE crm.messages ADD COLUMN IF NOT EXISTS purpose varchar(40) NULL');
      await q('ALTER TABLE crm.messages DROP CONSTRAINT IF EXISTS messages_purpose_format_ck');
      await q("ALTER TABLE crm.messages ADD CONSTRAINT messages_purpose_format_ck CHECK (purpose IS NULL OR purpose ~ '^[A-Z0-9_]{2,40}$')");
      await q(`CREATE INDEX IF NOT EXISTS crm_messages_cap_idx
        ON crm.messages (company_id, person_id, channel, purpose, created_at DESC) WHERE direction = 'OUTBOUND' AND purpose IS NOT NULL`);
    });
  },

  async down(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql) => sequelize.query(sql, { transaction });
      await q('DROP INDEX IF EXISTS crm.crm_messages_cap_idx');
      await q('ALTER TABLE crm.messages DROP CONSTRAINT IF EXISTS messages_purpose_format_ck');
      await q('ALTER TABLE crm.messages DROP COLUMN IF EXISTS purpose');
    });
  },
};
