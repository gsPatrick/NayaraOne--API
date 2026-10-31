'use strict';

/**
 * M9-D441 — índice da janela de atendimento do canSend.
 *
 * Fora da janela de atendimento de 24 h, o WhatsApp só aceita template oficial; o canSend confere se a pessoa escreveu naquele canal dentro da janela
 * (crm.messages, direction = 'INBOUND', company_id + person_id + channel + created_at). Só havia índice para as mensagens OUTBOUND com finalidade (frequency cap),
 * então a conferência varria a tabela inteira a cada envio. O índice parcial atende só a mensagem recebida e não pesa nas demais.
 * RLS, FORCE e GRANTs da tabela não mudam. Idempotente (IF NOT EXISTS), numa transação. O down remove o índice.
 */
module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      await sequelize.query(
        `CREATE INDEX IF NOT EXISTS crm_messages_inbound_window_idx
           ON crm.messages (company_id, person_id, channel, created_at DESC) WHERE direction = 'INBOUND'`,
        { transaction }
      );
    });
  },

  async down(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      await sequelize.query('DROP INDEX IF EXISTS crm.crm_messages_inbound_window_idx', { transaction });
    });
  },
};
