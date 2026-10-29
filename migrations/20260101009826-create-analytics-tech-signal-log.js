'use strict';

/**
 * Marco 9, demanda M9-D628 (Caderno "Dashboards + BI + Centro de Comando", §12 KPIs Tecnologia/IA): registro dos sinais técnicos GLOBAIS que alimentam
 * rm_tech_availability e rm_tech_auth_failures, porque o ERP ainda não guardava histórico das sondas de saúde nem das falhas de autenticação.
 *  - kind PROBE: uma sonda (API, banco, fila, storage) com ok verdadeiro ou falso e o instante da medição (a cada minuto, M9-D628 3.4);
 *  - kind LOGIN_FAILURE e MFA_FAILURE: uma falha de autenticação. Sem e-mail, IP nem nome: só o hash SHA-256 do usuário (ou do e-mail digitado) e do IP,
 *    para contar usuários distintos sem identificar ninguém (a identificação fica no drill-down com permissão).
 * O sinal é do sistema, não de uma empresa: a tabela NÃO tem company_id (por isso fora da varredura de RLS multiempresa), mas tem RLS ENABLE + FORCE e só
 * o escritor do BI (app.analytics_writer = 'on', o worker de read models e o job de sondas) lê e grava; requisição de empresa não enxerga nada.
 * Faixa reservada: 9826 a 9833.
 */
const WRITER_ON = "COALESCE(current_setting('app.analytics_writer', true), '') = 'on'";

module.exports = {
  up: async (queryInterface) => {
    const q = (sql) => queryInterface.sequelize.query(sql);
    await q('CREATE SCHEMA IF NOT EXISTS "analytics"');
    await q(`
      CREATE TABLE IF NOT EXISTS "analytics"."tech_signal_log" (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        kind varchar(16) NOT NULL CHECK (kind IN ('PROBE', 'LOGIN_FAILURE', 'MFA_FAILURE')),
        probe varchar(32),
        ok boolean,
        actor_hash char(64),
        ip_hash char(64),
        occurred_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT tech_signal_log_probe_chk CHECK ((kind = 'PROBE' AND probe IS NOT NULL AND ok IS NOT NULL) OR (kind <> 'PROBE' AND probe IS NULL AND ok IS NULL))
      )
    `);
    await q('CREATE INDEX IF NOT EXISTS tech_signal_log_kind_idx ON "analytics"."tech_signal_log" (kind, occurred_at)');
    await q('ALTER TABLE "analytics"."tech_signal_log" ENABLE ROW LEVEL SECURITY');
    await q('ALTER TABLE "analytics"."tech_signal_log" FORCE ROW LEVEL SECURITY');
    for (const name of ['tech_signal_select', 'tech_signal_insert', 'tech_signal_delete']) await q(`DROP POLICY IF EXISTS ${name} ON "analytics"."tech_signal_log"`);
    await q(`CREATE POLICY tech_signal_select ON "analytics"."tech_signal_log" FOR SELECT USING (${WRITER_ON})`);
    await q(`CREATE POLICY tech_signal_insert ON "analytics"."tech_signal_log" FOR INSERT WITH CHECK (${WRITER_ON})`);
    await q(`CREATE POLICY tech_signal_delete ON "analytics"."tech_signal_log" FOR DELETE USING (${WRITER_ON})`);
    await q(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nayara_runtime') THEN
          GRANT USAGE ON SCHEMA "analytics" TO nayara_runtime;
          GRANT SELECT, INSERT, DELETE ON "analytics"."tech_signal_log" TO nayara_runtime;
        END IF;
      END $$;
    `);
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query('DROP TABLE IF EXISTS "analytics"."tech_signal_log"');
  },
};
