'use strict';

/**
 * Migration: Marco 8 Fase 5 (Caderno "CORRESPONDENTE BANCÁRIO + NC + FINANCIAMENTOS") —
 * `correspondent.provider_submissions`. Invariantes do Caderno: "Submission possui snapshot/hash
 * e idempotency_key" / "Timeout de envio gera UNKNOWN/consulta antes de reenviar" / "Se já existe
 * submission por key, retornar existente" — por isso `idempotency_key` é UNIQUE por empresa (não
 * globalmente único, pra nunca colidir entre tenants diferentes que por acaso gerem a mesma key).
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    const sequelize = queryInterface.sequelize;

    await queryInterface.createTable(
      { tableName: 'provider_submissions', schema: 'correspondent' },
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
        financing_case_id: {
          type: Sequelize.UUID, allowNull: false,
          references: { model: { tableName: 'financing_cases', schema: 'correspondent' }, key: 'id' }, onDelete: 'CASCADE', onUpdate: 'CASCADE',
        },
        provider_code: { type: Sequelize.STRING(32), allowNull: false },
        idempotency_key: { type: Sequelize.STRING(160), allowNull: false },
        snapshot_hash: { type: Sequelize.STRING(64), allowNull: false, comment: 'SHA-256 do request snapshot enviado ao adapter — nunca reenviado cego após UNKNOWN.' },
        request_snapshot: { type: Sequelize.JSONB, allowNull: false },
        status: { type: Sequelize.STRING(16), allowNull: false, defaultValue: 'PENDING', comment: 'PENDING | SUBMITTED | UNKNOWN | FAILED' },
        external_case_id: { type: Sequelize.STRING(160), allowNull: true },
        response_snapshot: { type: Sequelize.JSONB, allowNull: true },
        failure_reason: { type: Sequelize.TEXT, allowNull: true },
        created_by: { type: Sequelize.UUID, allowNull: true },
        created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
        updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      }
    );

    // UNIQUE por empresa, não globalmente — mesma lógica de qualquer idempotency_key de outbox
    // do projeto, aplicada aqui por tabela própria (não reusa a outbox porque submission tem
    // estado próprio que evolui depois de criada: PENDING -> SUBMITTED/UNKNOWN/FAILED).
    await sequelize.query(`
      CREATE UNIQUE INDEX provider_submissions_idempotency_key_company_idx
        ON "correspondent"."provider_submissions" (company_id, idempotency_key);
    `);
    await sequelize.query(`
      CREATE INDEX provider_submissions_financing_case_idx
        ON "correspondent"."provider_submissions" (financing_case_id, created_at DESC);
    `);

    await sequelize.query('ALTER TABLE "correspondent"."provider_submissions" ENABLE ROW LEVEL SECURITY;');
    await sequelize.query('ALTER TABLE "correspondent"."provider_submissions" FORCE ROW LEVEL SECURITY;');
    await sequelize.query(`
      CREATE POLICY tenant_isolation ON "correspondent"."provider_submissions"
        USING (company_id = NULLIF(current_setting('app.company_id', true), '')::uuid);
    `);

    // ACHADO REAL já documentado na Fase 2/3 (PADRAO_COMPONENTES_E_REGRAS.md §2.4): o
    // `ALTER DEFAULT PRIVILEGES FOR ROLE nayara_migration` nunca se aplica de verdade — a
    // credencial real de DDL é "nayaraonebanco". GRANT explícito aqui, não confiar no default.
    const [[{ exists: runtimeExists }]] = await sequelize.query(
      "SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nayara_runtime') AS exists;"
    );
    if (runtimeExists) {
      await sequelize.query('GRANT SELECT, INSERT, UPDATE, DELETE ON "correspondent"."provider_submissions" TO nayara_runtime;');
    }
  },

  down: async (queryInterface) => {
    const sequelize = queryInterface.sequelize;
    await sequelize.query('DROP POLICY IF EXISTS tenant_isolation ON "correspondent"."provider_submissions";');
    await sequelize.query('ALTER TABLE "correspondent"."provider_submissions" DISABLE ROW LEVEL SECURITY;');
    await queryInterface.dropTable({ tableName: 'provider_submissions', schema: 'correspondent' });
  },
};
