'use strict';

/**
 * Marco 9, M9-D224 — integration.alerts: os alertas operacionais das integrações (PROVIDER_DOWN, ERROR_RATE_UP, AUTH_FAILURE,
 * SECRET_EXPIRING, SYNC_STALLED e QUOTA_LOW).
 *
 * Um alerta ABERTO por (connection, tipo, janela): o índice parcial único é a trava de idempotência (a mesma condição não abre duas
 * linhas) e é o que o antiflap consulta (`last_notified_at`). `window_key` distingue condições do mesmo tipo na mesma connection:
 * o marco do aviso de segredo (30, 14 ou 7 dias) e o fluxo de sincronização parado; nos demais tipos é vazio. Quando a condição some
 * o alerta vai a RESOLVED (`resolution`) e, se foi a condição que sumiu, a recuperação é avisada uma vez (`recovery_notified_at`).
 * `details` guarda só números e códigos (taxa, dias, minutos, nomes de fluxo): nunca segredo nem corpo de fornecedor.
 *
 * O role de runtime não recebe DELETE (o histórico de alertas é trilha de operação).
 */
const TIPOS = ['PROVIDER_DOWN', 'ERROR_RATE_UP', 'AUTH_FAILURE', 'SECRET_EXPIRING', 'SYNC_STALLED', 'QUOTA_LOW'];
const lista = (xs) => xs.map((x) => `'${x}'`).join(', ');

module.exports = {
  up: async (queryInterface) => {
    const q = (sql) => queryInterface.sequelize.query(sql);
    await q(`
      CREATE TABLE "integration"."alerts" (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        group_id uuid NOT NULL REFERENCES "core"."groups"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
        company_id uuid NOT NULL REFERENCES "core"."companies"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
        connection_id uuid NOT NULL REFERENCES "integration"."connections"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
        provider_code varchar(48) NOT NULL,
        alert_type varchar(20) NOT NULL CHECK (alert_type IN (${lista(TIPOS)})),
        window_key varchar(64) NOT NULL DEFAULT '',
        severity varchar(10) NOT NULL CHECK (severity IN ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL')),
        status varchar(10) NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'RESOLVED')),
        details jsonb NOT NULL DEFAULT '{}'::jsonb,
        runbook_path varchar(160) NOT NULL,
        opened_at timestamptz NOT NULL DEFAULT now(),
        last_notified_at timestamptz,
        notify_count integer NOT NULL DEFAULT 0 CHECK (notify_count >= 0),
        resolved_at timestamptz,
        resolution varchar(20) CHECK (resolution IS NULL OR resolution IN ('CONDITION_CLEARED', 'SUPERSEDED', 'CONNECTION_CHANGED')),
        recovery_notified_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT alerts_resolved_check CHECK ((status = 'OPEN' AND resolved_at IS NULL AND resolution IS NULL) OR (status = 'RESOLVED' AND resolved_at IS NOT NULL AND resolution IS NOT NULL))
      );
    `);
    await q('CREATE UNIQUE INDEX alerts_open_unique ON "integration"."alerts" (connection_id, alert_type, window_key) WHERE status = \'OPEN\';');
    await q('CREATE INDEX alerts_company_status_idx ON "integration"."alerts" (company_id, status, opened_at DESC);');
    await q('ALTER TABLE "integration"."alerts" ENABLE ROW LEVEL SECURITY;');
    await q(`CREATE POLICY tenant_isolation ON "integration"."alerts"
      USING (company_id = NULLIF(current_setting('app.company_id', true), '')::uuid)
      WITH CHECK (company_id = NULLIF(current_setting('app.company_id', true), '')::uuid);`);
    await q('ALTER TABLE "integration"."alerts" FORCE ROW LEVEL SECURITY;');
    await q(`
      DO $g$
      BEGIN
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nayara_runtime') THEN
          GRANT USAGE ON SCHEMA "integration" TO nayara_runtime;
          GRANT SELECT, INSERT, UPDATE ON "integration"."alerts" TO nayara_runtime;
        END IF;
      END $g$;
    `);
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query('DROP TABLE IF EXISTS "integration"."alerts";');
  },
};
