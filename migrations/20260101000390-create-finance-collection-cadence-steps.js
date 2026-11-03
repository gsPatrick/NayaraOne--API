'use strict';

/**
 * Cadência de cobrança de locação (conferência Nayara 18/10/2026, matriz Marco 5 "Multa, juros,
 * carência, cadência e acordo"; Caderno p.158 "Multa/juros/grace/cadência via Motor de Regras;
 * acordo versionado não apaga dívida").
 *
 * Cada etapa da régua de cobrança (regra REG-LOC-004) executada para uma competência
 * (billing_schedule) vira UMA linha aqui — UNIQUE (billing_schedule_id, step_code) garante que
 * rodar o job de novo nunca repete a etapa. A linha guarda a versão da regra usada
 * (rule_version_id): a competência fica presa à versão em que a cadência começou; uma nova
 * versão publicada vale para as competências que ainda não começaram. Append-only: a linha
 * registra um fato (a etapa foi executada/pulada) e nunca é alterada nem apagada.
 */

const FUNCTION_NAME = 'finance.enforce_collection_cadence_steps_append_only';
const TRIGGER_NAME = 'trg_collection_cadence_steps_append_only';

module.exports = {
  async up(queryInterface, Sequelize) {
    const table = { tableName: 'collection_cadence_steps', schema: 'finance' };
    await queryInterface.createTable(table, {
      id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true, allowNull: false },
      group_id: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: { tableName: 'groups', schema: 'core' }, key: 'id' },
        onDelete: 'RESTRICT',
        onUpdate: 'CASCADE',
      },
      company_id: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: { tableName: 'companies', schema: 'core' }, key: 'id' },
        onDelete: 'RESTRICT',
        onUpdate: 'CASCADE',
      },
      billing_schedule_id: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: { tableName: 'billing_schedules', schema: 'finance' }, key: 'id' },
        onDelete: 'RESTRICT',
        onUpdate: 'CASCADE',
      },
      contract_id: { type: Sequelize.UUID, allowNull: false },
      rule_version_id: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: { tableName: 'rule_versions', schema: 'core' }, key: 'id' },
        onDelete: 'RESTRICT',
        onUpdate: 'CASCADE',
      },
      step_code: { type: Sequelize.STRING(40), allowNull: false },
      offset_days: { type: Sequelize.INTEGER, allowNull: false },
      action: { type: Sequelize.STRING(32), allowNull: false, comment: 'NOTIFY | TASK | ESCALATE_LEGAL' },
      outcome: { type: Sequelize.STRING(32), allowNull: false, comment: 'EXECUTED | SKIPPED_SUPERSEDED' },
      business_date: { type: Sequelize.DATEONLY, allowNull: false, comment: 'Data de negócio (America/Sao_Paulo) da execução' },
      days_from_due: { type: Sequelize.INTEGER, allowNull: false },
      balance_at_step: { type: Sequelize.DECIMAL(18, 2), allowNull: false },
      notification_id: { type: Sequelize.UUID, allowNull: true },
      task_id: { type: Sequelize.UUID, allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
    });

    await queryInterface.addIndex(table, ['billing_schedule_id', 'step_code'], {
      name: 'collection_cadence_steps_schedule_step_uq',
      unique: true,
    });
    await queryInterface.addIndex(table, ['company_id', 'contract_id'], { name: 'collection_cadence_steps_contract_idx' });

    await queryInterface.sequelize.query('ALTER TABLE "finance"."collection_cadence_steps" ENABLE ROW LEVEL SECURITY;');
    await queryInterface.sequelize.query('ALTER TABLE "finance"."collection_cadence_steps" FORCE ROW LEVEL SECURITY;');
    await queryInterface.sequelize.query(`
      CREATE POLICY tenant_isolation ON "finance"."collection_cadence_steps"
        USING (company_id = NULLIF(current_setting('app.company_id', true), '')::uuid);
    `);

    await queryInterface.sequelize.query(`
      CREATE OR REPLACE FUNCTION ${FUNCTION_NAME}()
      RETURNS TRIGGER AS $$
      BEGIN
        RAISE EXCEPTION 'finance.collection_cadence_steps é append-only: a etapa de cobrança registrada nunca é alterada nem apagada (id=%).', OLD.id
          USING ERRCODE = '23514';
      END;
      $$ LANGUAGE plpgsql;
    `);
    await queryInterface.sequelize.query(`
      DROP TRIGGER IF EXISTS ${TRIGGER_NAME} ON "finance"."collection_cadence_steps";
      CREATE TRIGGER ${TRIGGER_NAME}
        BEFORE UPDATE OR DELETE ON "finance"."collection_cadence_steps"
        FOR EACH ROW
        EXECUTE FUNCTION ${FUNCTION_NAME}();
    `);

    const [[{ exists: runtimeExists }]] = await queryInterface.sequelize.query(
      "SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nayara_runtime') AS exists;"
    );
    if (runtimeExists) {
      await queryInterface.sequelize.query('GRANT SELECT, INSERT ON "finance"."collection_cadence_steps" TO nayara_runtime;');
    }
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`DROP TRIGGER IF EXISTS ${TRIGGER_NAME} ON "finance"."collection_cadence_steps";`);
    await queryInterface.sequelize.query(`DROP FUNCTION IF EXISTS ${FUNCTION_NAME}();`);
    await queryInterface.sequelize.query('DROP POLICY IF EXISTS tenant_isolation ON "finance"."collection_cadence_steps";');
    await queryInterface.dropTable({ tableName: 'collection_cadence_steps', schema: 'finance' });
  },
};
