'use strict';

/**
 * Marco 9, M9-D214 — integration.dispatch_attempts: uma linha por tentativa de chamada a fornecedor, gravada ANTES da chamada
 * (started_at) e fechada com o resultado (outcome, classe do erro, status HTTP, latência). É a fonte das amostras de saúde
 * (M9-D206), da janela do limitador local (M9-D218) e do histórico de retry (M9-D216). Só ids, classes e números: nunca conteúdo
 * do envio. RLS ENABLE + FORCE por empresa; o runtime lê, grava e fecha, nunca apaga (a linha sai junto com o envio, por
 * ON DELETE CASCADE, quando a retenção da M9-D205 remove o envio).
 */
module.exports = {
  up: async (queryInterface) => {
    const q = (sql) => queryInterface.sequelize.query(sql);
    await q(`
      CREATE TABLE "integration"."dispatch_attempts" (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        group_id uuid NOT NULL REFERENCES "core"."groups"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
        company_id uuid NOT NULL REFERENCES "core"."companies"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
        dispatch_id uuid NOT NULL REFERENCES "integration"."dispatches"(id) ON DELETE CASCADE ON UPDATE CASCADE,
        connection_id uuid NOT NULL REFERENCES "integration"."connections"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
        provider_code varchar(48) NOT NULL,
        attempt_no integer NOT NULL CHECK (attempt_no >= 1),
        started_at timestamptz NOT NULL DEFAULT now(),
        finished_at timestamptz,
        outcome varchar(10) CHECK (outcome IS NULL OR outcome IN ('SUCCESS', 'ERROR')),
        error_class varchar(12) CHECK (error_class IS NULL OR error_class IN ('TRANSIENT', 'RATE_LIMIT', 'AUTH', 'VALIDATION', 'UNKNOWN')),
        error_code varchar(64),
        http_status integer,
        latency_ms integer CHECK (latency_ms IS NULL OR latency_ms >= 0),
        created_at timestamptz NOT NULL DEFAULT now()
      );
    `);
    await q('CREATE INDEX dispatch_attempts_dispatch_idx ON "integration"."dispatch_attempts" (dispatch_id, attempt_no);');
    await q('CREATE INDEX dispatch_attempts_connection_idx ON "integration"."dispatch_attempts" (connection_id, started_at DESC);');
    await q('ALTER TABLE "integration"."dispatch_attempts" ENABLE ROW LEVEL SECURITY;');
    await q(`CREATE POLICY tenant_isolation ON "integration"."dispatch_attempts"
      USING (company_id = NULLIF(current_setting('app.company_id', true), '')::uuid)
      WITH CHECK (company_id = NULLIF(current_setting('app.company_id', true), '')::uuid);`);
    await q('ALTER TABLE "integration"."dispatch_attempts" FORCE ROW LEVEL SECURITY;');
    await q(`
      DO $g$
      BEGIN
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nayara_runtime') THEN
          GRANT USAGE ON SCHEMA "integration" TO nayara_runtime;
          GRANT SELECT, INSERT, UPDATE ON "integration"."dispatch_attempts" TO nayara_runtime;
        END IF;
      END $g$;
    `);
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query('DROP TABLE IF EXISTS "integration"."dispatch_attempts";');
  },
};
