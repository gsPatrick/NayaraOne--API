'use strict';

/**
 * Marco 9, M9-D229 — a mensagem do CRM (crm.messages, a "interação" do livro) guarda o recurso no fornecedor e o status de entrega por evidência.
 * Colunas novas: connection_id (a connection que enviou ou recebeu), dispatch_id (o envio que a levou ao fornecedor) e delivery_status (QUEUED, SENT, DELIVERED, READ, FAILED;
 * nulo = mensagem que não passou por fornecedor). O UNIQUE de external_message_id deixa de ser global e passa a ser por connection: (connection_id, external_message_id), que é o que
 * deduplica a mensagem recebida e impede dois registros para o mesmo recurso; sem connection (histórico antigo) o identificador segue único sozinho. RLS, FORCE e GRANTs não mudam.
 * Idempotente (IF NOT EXISTS), numa transação.
 */
module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql) => sequelize.query(sql, { transaction });
      await q('ALTER TABLE "crm"."messages" ADD COLUMN IF NOT EXISTS connection_id uuid NULL REFERENCES "integration"."connections" (id) ON DELETE RESTRICT');
      await q('ALTER TABLE "crm"."messages" ADD COLUMN IF NOT EXISTS dispatch_id uuid NULL REFERENCES "integration"."dispatches" (id) ON DELETE SET NULL');
      await q('ALTER TABLE "crm"."messages" ADD COLUMN IF NOT EXISTS delivery_status varchar(16) NULL');
      await q('ALTER TABLE "crm"."messages" DROP CONSTRAINT IF EXISTS messages_delivery_status_ck');
      await q("ALTER TABLE \"crm\".\"messages\" ADD CONSTRAINT messages_delivery_status_ck CHECK (delivery_status IS NULL OR delivery_status IN ('QUEUED', 'SENT', 'DELIVERED', 'READ', 'FAILED'))");
      await q('ALTER TABLE "crm"."messages" DROP CONSTRAINT IF EXISTS messages_external_message_id_key');
      await q('CREATE UNIQUE INDEX IF NOT EXISTS crm_messages_external_id_legacy_uq ON "crm"."messages" (external_message_id) WHERE external_message_id IS NOT NULL AND connection_id IS NULL');
      await q('CREATE UNIQUE INDEX IF NOT EXISTS crm_messages_connection_external_uq ON "crm"."messages" (connection_id, external_message_id) WHERE connection_id IS NOT NULL AND external_message_id IS NOT NULL');
      await q('CREATE INDEX IF NOT EXISTS crm_messages_dispatch_idx ON "crm"."messages" (dispatch_id) WHERE dispatch_id IS NOT NULL');
    });
  },

  async down(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql) => sequelize.query(sql, { transaction });
      await q('DROP INDEX IF EXISTS "crm"."crm_messages_dispatch_idx"');
      await q('DROP INDEX IF EXISTS "crm"."crm_messages_connection_external_uq"');
      await q('DROP INDEX IF EXISTS "crm"."crm_messages_external_id_legacy_uq"');
      await q('ALTER TABLE "crm"."messages" DROP CONSTRAINT IF EXISTS messages_delivery_status_ck');
      await q('ALTER TABLE "crm"."messages" DROP COLUMN IF EXISTS delivery_status');
      await q('ALTER TABLE "crm"."messages" DROP COLUMN IF EXISTS dispatch_id');
      await q('ALTER TABLE "crm"."messages" DROP COLUMN IF EXISTS connection_id');
      await q('ALTER TABLE "crm"."messages" ADD CONSTRAINT messages_external_message_id_key UNIQUE (external_message_id)');
    });
  },
};
