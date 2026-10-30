'use strict';

/**
 * M9-D429 regra 7 — resultado desconhecido (timeout no envio): a mensagem automática do Marketing fica UNKNOWN até a consulta pela action_key confirmar. O
 * status UNKNOWN já é reconhecido pelo frequency cap e pelo cooldown (M9-D416: conta, pois o canal pode ter entregue); falta aceitá-lo na coluna
 * `delivery_status`. Só amplia o conjunto aceito; nenhuma linha existente muda. O down volta ao conjunto anterior (recusa se houver linha UNKNOWN).
 */
const NEW_SET = "('QUEUED', 'SENT', 'DELIVERED', 'READ', 'FAILED', 'CANCELLED', 'UNKNOWN')";
const OLD_SET = "('QUEUED', 'SENT', 'DELIVERED', 'READ', 'FAILED', 'CANCELLED')";

module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql) => sequelize.query(sql, { transaction });
      await q('ALTER TABLE "crm"."messages" DROP CONSTRAINT IF EXISTS messages_delivery_status_ck');
      await q(`ALTER TABLE "crm"."messages" ADD CONSTRAINT messages_delivery_status_ck CHECK (delivery_status IS NULL OR delivery_status IN ${NEW_SET})`);
    });
  },

  async down(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql) => sequelize.query(sql, { transaction });
      const [[{ n }]] = await sequelize.query("SELECT count(*)::int AS n FROM crm.messages WHERE delivery_status = 'UNKNOWN'", { transaction });
      if (n > 0) throw new Error(`MKT_MIGRATION_DOWN_NOT_EMPTY: ${n} mensagem(ns) com delivery_status UNKNOWN; o down não apaga dados.`);
      await q('ALTER TABLE "crm"."messages" DROP CONSTRAINT IF EXISTS messages_delivery_status_ck');
      await q(`ALTER TABLE "crm"."messages" ADD CONSTRAINT messages_delivery_status_ck CHECK (delivery_status IS NULL OR delivery_status IN ${OLD_SET})`);
    });
  },
};
