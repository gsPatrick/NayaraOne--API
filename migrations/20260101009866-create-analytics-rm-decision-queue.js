'use strict';

/**
 * Marco 9, demanda M9-D709 (Centro de Comando, "o que exige decisão"): read model analytics.rm_decision_queue, uma linha por item que espera (ou esperou) uma
 * decisão humana: aprovação financeira (FIN_APPROVAL), proposta de ajuste de estoque (INV_ADJUSTMENT), pedido de aprovação de regra (RULE_APPROVAL) e proposta
 * da NAY com ação proposta (NAY_PROPOSAL). Chave de negócio (company_id, kind, source_id); o `id` é derivado dela (mesmo item, mesmo id, também no rebuild). O ESTADO da fonte é recalculado a cada evento e pela agenda de 15
 * minutos (nunca delta); item decidido ou cancelado fica na tabela com status e data (o histórico do número está nos snapshots). Só ids técnicos, valor,
 * datas e rótulos de código: nenhum nome, documento nem texto livre (o título é curto e sem dado sensível).
 * RLS ENABLE + FORCE: leitura pelas GUCs de empresa/grupo; escrita só com app.analytics_writer = 'on' (worker de read models, M9-D607).
 * GRANT ao nayara_runtime só se o role existir. Idempotente. Faixa reservada: 9866 a 9873.
 */
const SCHEMA = 'analytics';
const TABLE = 'rm_decision_queue';
const COMPANY_GUC = "NULLIF(current_setting('app.company_id', true), '')::uuid";
const GROUP_GUC = "NULLIF(current_setting('app.group_id', true), '')::uuid";
const WRITER_ON = "COALESCE(current_setting('app.analytics_writer', true), '') = 'on'";
const READ_TENANT = `(company_id = ${COMPANY_GUC} AND group_id = ${GROUP_GUC})`;
const T = `"${SCHEMA}"."${TABLE}"`;

module.exports = {
  up: async (queryInterface) => {
    const q = (sql) => queryInterface.sequelize.query(sql);
    await q(`CREATE SCHEMA IF NOT EXISTS "${SCHEMA}"`);
    await q(`
      CREATE TABLE IF NOT EXISTS ${T} (
        id uuid GENERATED ALWAYS AS ((md5(company_id::text || '|' || kind || '|' || source_id::text))::uuid) STORED,
        company_id uuid NOT NULL REFERENCES "core"."companies"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
        group_id uuid NOT NULL REFERENCES "core"."groups"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
        kind varchar(20) NOT NULL CHECK (kind IN ('FIN_APPROVAL', 'INV_ADJUSTMENT', 'RULE_APPROVAL', 'NAY_PROPOSAL')),
        source_type varchar(64) NOT NULL,
        source_id uuid NOT NULL,
        title varchar(200) NOT NULL,
        amount numeric(20,2),
        requested_at timestamptz,
        requested_by uuid,
        owner_role varchar(120) NOT NULL,
        status varchar(12) NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'DECIDED', 'CANCELED')),
        decided_at timestamptz,
        approval_type varchar(64),
        approval_tier varchar(16),
        warehouse_id uuid,
        reason_code varchar(32),
        item_id uuid,
        quantity numeric(18,4),
        rule_id uuid,
        agent_code varchar(64),
        proposal_type varchar(64),
        run_id uuid,
        has_sources boolean,
        source_event_id uuid,
        source_snapshot_at timestamptz,
        refreshed_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
        CONSTRAINT rm_decision_queue_pk PRIMARY KEY (id),
        CONSTRAINT rm_decision_queue_decided_has_date CHECK (status = 'PENDING' OR decided_at IS NOT NULL)
      )
    `);
    await q(`CREATE UNIQUE INDEX IF NOT EXISTS rm_decision_queue_source_uq ON ${T} (company_id, kind, source_id)`);
    await q(`CREATE INDEX IF NOT EXISTS rm_decision_queue_pending_idx ON ${T} (company_id, status, kind, requested_at)`);
    await q(`ALTER TABLE ${T} ENABLE ROW LEVEL SECURITY`);
    await q(`ALTER TABLE ${T} FORCE ROW LEVEL SECURITY`);
    for (const name of ['analytics_select', 'analytics_insert', 'analytics_update', 'analytics_delete']) await q(`DROP POLICY IF EXISTS ${name} ON ${T}`);
    await q(`CREATE POLICY analytics_select ON ${T} FOR SELECT USING (${READ_TENANT})`);
    await q(`CREATE POLICY analytics_insert ON ${T} FOR INSERT WITH CHECK (${WRITER_ON} AND ${READ_TENANT})`);
    await q(`CREATE POLICY analytics_update ON ${T} FOR UPDATE USING (${WRITER_ON} AND ${READ_TENANT}) WITH CHECK (${WRITER_ON} AND ${READ_TENANT})`);
    await q(`CREATE POLICY analytics_delete ON ${T} FOR DELETE USING (${WRITER_ON} AND ${READ_TENANT})`);
    await q(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nayara_runtime') THEN
          GRANT USAGE ON SCHEMA "${SCHEMA}" TO nayara_runtime;
          GRANT SELECT, INSERT, UPDATE, DELETE ON ${T} TO nayara_runtime;
        END IF;
      END $$;
    `);
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query(`DROP TABLE IF EXISTS ${T}`);
  },
};
