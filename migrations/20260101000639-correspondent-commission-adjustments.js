'use strict';

/**
 * Migration: Marco 8 — ajuste de comissão como registro próprio (auditoria independente de 25/10/2026).
 *
 * O caderno diz "Chargeback/estorno preserva original" e "estorno cria ajuste". Até aqui o ajuste só
 * existia dentro do audit_log. Agora cada estorno grava uma linha em `commission_adjustments`
 * (append-only: só INSERT e SELECT), ligada ao direito original, com valor negativo, motivo e
 * quem fez. O direito original continua com o valor dele.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    const sequelize = queryInterface.sequelize;

    await queryInterface.createTable(
      { tableName: 'commission_adjustments', schema: 'correspondent' },
      {
        id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true, allowNull: false },
        group_id: {
          type: Sequelize.UUID, allowNull: false,
          references: { model: { tableName: 'groups', schema: 'core' }, key: 'id' }, onDelete: 'RESTRICT', onUpdate: 'CASCADE',
        },
        company_id: {
          type: Sequelize.UUID, allowNull: false,
          references: { model: { tableName: 'companies', schema: 'core' }, key: 'id' }, onDelete: 'RESTRICT', onUpdate: 'CASCADE',
        },
        commission_entitlement_id: {
          type: Sequelize.UUID, allowNull: false,
          references: { model: { tableName: 'commission_entitlements', schema: 'correspondent' }, key: 'id' }, onDelete: 'RESTRICT', onUpdate: 'CASCADE',
        },
        adjustment_type: { type: Sequelize.STRING(16), allowNull: false, defaultValue: 'CHARGEBACK' },
        status_before: { type: Sequelize.STRING(16), allowNull: false },
        amount: { type: Sequelize.DECIMAL(14, 2), allowNull: false },
        reason: { type: Sequelize.TEXT, allowNull: false },
        created_by: { type: Sequelize.UUID, allowNull: true },
        created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      }
    );
    await sequelize.query(`ALTER TABLE "correspondent"."commission_adjustments"
      ADD CONSTRAINT commission_adjustments_type_check CHECK (adjustment_type IN ('CHARGEBACK')),
      ADD CONSTRAINT commission_adjustments_amount_check CHECK (amount < 0);`);
    await sequelize.query('CREATE INDEX commission_adjustments_entitlement_idx ON "correspondent"."commission_adjustments" (commission_entitlement_id, created_at);');
    await sequelize.query('ALTER TABLE "correspondent"."commission_adjustments" ENABLE ROW LEVEL SECURITY;');
    await sequelize.query('ALTER TABLE "correspondent"."commission_adjustments" FORCE ROW LEVEL SECURITY;');
    await sequelize.query(`CREATE POLICY tenant_isolation ON "correspondent"."commission_adjustments"
      USING (company_id = NULLIF(current_setting('app.company_id', true), '')::uuid);`);

    const [[{ exists: runtimeExists }]] = await sequelize.query("SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nayara_runtime') AS exists;");
    if (runtimeExists) {
      await sequelize.query('GRANT SELECT, INSERT ON "correspondent"."commission_adjustments" TO nayara_runtime;');
    }
  },

  down: async (queryInterface) => {
    await queryInterface.dropTable({ tableName: 'commission_adjustments', schema: 'correspondent' });
  },
};
