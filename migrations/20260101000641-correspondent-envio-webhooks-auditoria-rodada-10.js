'use strict';

/**
 * Migration: Marco 8 — fechamentos da auditoria exaustiva da rodada 10 (envio, webhooks, status).
 *
 * 1) `webhook_pending`: webhook de um id de caso que o sistema ainda não conhece (o provider
 *    respondeu antes de o roteamento ser gravado) fica guardado, com a assinatura original, para ser
 *    reprocessado quando o roteamento existir. Sem RLS e sem company_id (ainda não se sabe a empresa);
 *    a assinatura só é conferida no reprocessamento, depois de descobrir a empresa.
 * 2) `provider_status_history`: coluna `provider_occurred_at` (a hora do PROVIDER, separada da hora
 *    local, para não misturar relógios), status bruto até 255 caracteres e histórico append-only
 *    garantido também por privilégio (sem UPDATE/DELETE para o papel de runtime).
 * 3) `external_case_routing`: o service agora só insere (INSERT ... ON CONFLICT DO NOTHING e compara o
 *    dono): sem UPDATE/DELETE para o runtime, com FK para o caso e índice por caso.
 * 4) `financing_cases`: `client_request_id` (idempotência da criação: duplo clique não cria 2 casos) e
 *    índices de status/impressão digital usados pelos jobs.
 * 5) CHECKs de domínio (NOT VALID: valem para linhas novas e não derrubam dados antigos).
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    const sequelize = queryInterface.sequelize;
    const hasRuntime = async () => {
      const [[{ exists }]] = await sequelize.query("SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nayara_runtime') AS exists;");
      return exists;
    };

    // 1) webhooks de ids ainda desconhecidos
    await queryInterface.createTable(
      { tableName: 'webhook_pending', schema: 'correspondent' },
      {
        id: { type: Sequelize.UUID, primaryKey: true, allowNull: false, defaultValue: Sequelize.literal('gen_random_uuid()') },
        provider_code: { type: Sequelize.STRING(32), allowNull: false },
        external_case_id: { type: Sequelize.STRING(160), allowNull: false },
        external_event_id: { type: Sequelize.STRING(160), allowNull: false },
        raw_body: { type: Sequelize.TEXT, allowNull: false },
        signature: { type: Sequelize.TEXT, allowNull: true },
        attempts: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
        received_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
        processed_at: { type: Sequelize.DATE, allowNull: true },
        created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      }
    );
    await sequelize.query(`CREATE UNIQUE INDEX webhook_pending_provider_event_idx
      ON "correspondent"."webhook_pending" (provider_code, external_event_id);`);
    await sequelize.query(`CREATE INDEX webhook_pending_case_idx
      ON "correspondent"."webhook_pending" (provider_code, external_case_id) WHERE processed_at IS NULL;`);
    await sequelize.query('ALTER TABLE "correspondent"."webhook_pending" ADD CONSTRAINT webhook_pending_body_size CHECK (length(raw_body) <= 262144);');

    // 2) histórico de status
    await queryInterface.addColumn({ tableName: 'provider_status_history', schema: 'correspondent' }, 'provider_occurred_at', { type: Sequelize.DATE, allowNull: true });
    await sequelize.query('ALTER TABLE "correspondent"."provider_status_history" ALTER COLUMN raw_provider_status TYPE VARCHAR(255);');
    // Linhas antigas de webhook: o relógio gravado era o do provider quando válido; mantém a comparação funcionando.
    await sequelize.query(`UPDATE "correspondent"."provider_status_history" SET provider_occurred_at = occurred_at WHERE source = 'webhook' AND provider_occurred_at IS NULL;`);

    // 3) roteamento de webhook
    await sequelize.query(`DELETE FROM "correspondent"."external_case_routing" r
      WHERE NOT EXISTS (SELECT 1 FROM "correspondent"."financing_cases" c WHERE c.id = r.financing_case_id);`);
    await sequelize.query(`ALTER TABLE "correspondent"."external_case_routing"
      ADD CONSTRAINT external_case_routing_case_fk FOREIGN KEY (financing_case_id)
      REFERENCES "correspondent"."financing_cases" (id) ON DELETE CASCADE;`);
    await sequelize.query(`CREATE INDEX IF NOT EXISTS external_case_routing_case_idx
      ON "correspondent"."external_case_routing" (financing_case_id);`);

    // 4) casos
    await queryInterface.addColumn({ tableName: 'financing_cases', schema: 'correspondent' }, 'client_request_id', { type: Sequelize.STRING(64), allowNull: true });
    await sequelize.query(`CREATE UNIQUE INDEX financing_cases_client_request_idx
      ON "correspondent"."financing_cases" (company_id, client_request_id) WHERE client_request_id IS NOT NULL;`);
    await sequelize.query(`CREATE INDEX IF NOT EXISTS financing_cases_company_status_idx
      ON "correspondent"."financing_cases" (company_id, status);`);
    await sequelize.query(`CREATE INDEX IF NOT EXISTS financing_cases_company_fingerprint_idx
      ON "correspondent"."financing_cases" (company_id, duplicate_fingerprint);`);

    // 5) CHECKs de domínio (NOT VALID)
    await sequelize.query(`ALTER TABLE "correspondent"."financing_cases" ADD CONSTRAINT financing_cases_status_domain
      CHECK (status IN ('DRAFT','DOCUMENTS_PENDING','READY_TO_SUBMIT','SUBMITTED','UNDER_ANALYSIS','PENDING_CUSTOMER','PENDING_PROPERTY','APPROVED','REJECTED','CONTRACTING','COMPLETED','CANCELED')) NOT VALID;`);
    await sequelize.query(`ALTER TABLE "correspondent"."provider_submissions" ADD CONSTRAINT provider_submissions_status_domain
      CHECK (status IN ('PENDING','SUBMITTED','UNKNOWN','FAILED','CANCELED')) NOT VALID;`);
    await sequelize.query(`ALTER TABLE "correspondent"."provider_status_history" ADD CONSTRAINT provider_status_history_source_domain
      CHECK (source IN ('webhook','poll','submission','manual','checklist')) NOT VALID;`);
    await sequelize.query(`ALTER TABLE "correspondent"."integration_errors" ADD CONSTRAINT integration_errors_status_domain
      CHECK (status IN ('OPEN','RESOLVED')) NOT VALID;`);

    if (await hasRuntime()) {
      await sequelize.query('GRANT SELECT, INSERT, UPDATE, DELETE ON "correspondent"."webhook_pending" TO nayara_runtime;');
      await sequelize.query('REVOKE UPDATE, DELETE ON "correspondent"."provider_status_history" FROM nayara_runtime;');
      await sequelize.query('REVOKE UPDATE, DELETE ON "correspondent"."external_case_routing" FROM nayara_runtime;');
    }
  },

  down: async (queryInterface) => {
    const sequelize = queryInterface.sequelize;
    const [[{ exists }]] = await sequelize.query("SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nayara_runtime') AS exists;");
    if (exists) {
      await sequelize.query('GRANT UPDATE, DELETE ON "correspondent"."external_case_routing" TO nayara_runtime;');
      await sequelize.query('GRANT UPDATE, DELETE ON "correspondent"."provider_status_history" TO nayara_runtime;');
    }
    await sequelize.query('ALTER TABLE "correspondent"."integration_errors" DROP CONSTRAINT IF EXISTS integration_errors_status_domain;');
    await sequelize.query('ALTER TABLE "correspondent"."provider_status_history" DROP CONSTRAINT IF EXISTS provider_status_history_source_domain;');
    await sequelize.query('ALTER TABLE "correspondent"."provider_submissions" DROP CONSTRAINT IF EXISTS provider_submissions_status_domain;');
    await sequelize.query('ALTER TABLE "correspondent"."financing_cases" DROP CONSTRAINT IF EXISTS financing_cases_status_domain;');
    await sequelize.query('DROP INDEX IF EXISTS "correspondent"."financing_cases_company_fingerprint_idx";');
    await sequelize.query('DROP INDEX IF EXISTS "correspondent"."financing_cases_company_status_idx";');
    await sequelize.query('DROP INDEX IF EXISTS "correspondent"."financing_cases_client_request_idx";');
    await queryInterface.removeColumn({ tableName: 'financing_cases', schema: 'correspondent' }, 'client_request_id');
    await sequelize.query('DROP INDEX IF EXISTS "correspondent"."external_case_routing_case_idx";');
    await sequelize.query('ALTER TABLE "correspondent"."external_case_routing" DROP CONSTRAINT IF EXISTS external_case_routing_case_fk;');
    await queryInterface.removeColumn({ tableName: 'provider_status_history', schema: 'correspondent' }, 'provider_occurred_at');
    await queryInterface.dropTable({ tableName: 'webhook_pending', schema: 'correspondent' });
  },
};
