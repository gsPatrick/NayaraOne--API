'use strict';

/**
 * Marco 9, demanda M9-D616 (Caderno "Dashboards + BI + Centro de Comando", §7 KPIs Comercial/Imóveis): read models no schema analytics, todos com
 * company_id/group_id, source_snapshot_at, refreshed_at e version (M9-D607), sem nome nem documento de pessoa (só ids e agregados).
 *  - rm_crm_lead_daily: leads por dia, origem e corretor, com a primeira resposta (contagem e soma de segundos).
 *  - rm_crm_opportunity_stage: oportunidades em andamento por estágio e corretor, e as paradas.
 *  - rm_crm_outcome: ganhas, perdidas e desistências por mês e corretor; motivos de perda por mês e corretor (lost_reason vazio = totais).
 *  - rm_crm_next_action: carteira em andamento e sem próxima ação, por corretor.
 *  - rm_crm_visits_proposals: visitas e propostas por dia.
 *  - rm_property_portfolio: imóveis ativos por situação e faixa de dias sem venda.
 *  - rm_property_price_changes: mudanças de preço por dia (quantidade, soma e média da variação percentual).
 *  - rm_radar_matches: cruzamentos do Radar por dia e os que viraram negócio.
 *  - rm_broker_performance: captação, leads recebidos e ganhos por corretor e mês.
 *  O corretor ausente usa o UUID zero (chave sempre preenchida, sem NULL na chave única; DI-D616-1).
 *
 * RLS ENABLE + FORCE: leitura pelas GUCs de empresa/grupo; escrita só com app.analytics_writer = 'on' (worker de read models, M9-D607).
 * GRANT ao nayara_runtime só se o role existir. Idempotente. Faixa reservada: 9717 a 9724.
 */
const SCHEMA = 'analytics';
const COMPANY_GUC = "NULLIF(current_setting('app.company_id', true), '')::uuid";
const GROUP_GUC = "NULLIF(current_setting('app.group_id', true), '')::uuid";
const WRITER_ON = "COALESCE(current_setting('app.analytics_writer', true), '') = 'on'";
const READ_TENANT = `(company_id = ${COMPANY_GUC} AND group_id = ${GROUP_GUC})`;
const T = (name) => `"${SCHEMA}"."${name}"`;
const COUNT = (name) => `"${name}" integer NOT NULL DEFAULT 0 CHECK ("${name}" >= 0)`;
const BIG = (name) => `"${name}" bigint NOT NULL DEFAULT 0 CHECK ("${name}" >= 0)`;
const PCT = (name) => `"${name}" numeric(14,4) NOT NULL DEFAULT 0`;
const MONTH = (name) => `"${name}" varchar(7) NOT NULL CHECK ("${name}" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$')`;

const COMMON = `
  source_snapshot_at timestamptz,
  refreshed_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1)`;

// [tabela, colunas da chave (DDL), nomes da chave, colunas de valor (DDL)]
const TABLES = [
  ['rm_crm_lead_daily', ['day date NOT NULL', "origin varchar(60) NOT NULL", 'broker_id uuid NOT NULL'], ['day', 'origin', 'broker_id'], [COUNT('leads'), COUNT('first_response_count'), BIG('first_response_seconds_sum')]],
  ['rm_crm_opportunity_stage', ['stage varchar(32) NOT NULL', 'broker_id uuid NOT NULL'], ['stage', 'broker_id'], [COUNT('count'), COUNT('stalled_count')]],
  ['rm_crm_outcome', [MONTH('month'), 'broker_id uuid NOT NULL', "lost_reason text NOT NULL DEFAULT ''"], ['month', 'broker_id', 'lost_reason'], [COUNT('won'), COUNT('lost'), COUNT('withdrawn'), COUNT('lost_count')]],
  ['rm_crm_next_action', ['broker_id uuid NOT NULL'], ['broker_id'], [COUNT('open_total'), COUNT('without_next_action')]],
  ['rm_crm_visits_proposals', ['day date NOT NULL'], ['day'], [COUNT('visits_scheduled'), COUNT('visits_done'), COUNT('proposals_sent'), COUNT('proposals_accepted')]],
  ['rm_property_portfolio', ['status varchar(32) NOT NULL', 'no_sale_days_bucket varchar(40) NOT NULL'], ['status', 'no_sale_days_bucket'], [COUNT('active_count')]],
  ['rm_property_price_changes', ['day date NOT NULL'], ['day'], [COUNT('changes'), PCT('change_pct_sum'), PCT('avg_change_pct')]],
  ['rm_radar_matches', ['day date NOT NULL'], ['day'], [COUNT('matches'), COUNT('converted')]],
  ['rm_broker_performance', ['broker_id uuid NOT NULL', MONTH('month')], ['broker_id', 'month'], [COUNT('captured'), COUNT('leads_assigned'), COUNT('won')]],
];

async function applyRls(q, table) {
  await q(`ALTER TABLE ${T(table)} ENABLE ROW LEVEL SECURITY`);
  await q(`ALTER TABLE ${T(table)} FORCE ROW LEVEL SECURITY`);
  for (const name of ['analytics_select', 'analytics_insert', 'analytics_update', 'analytics_delete']) {
    await q(`DROP POLICY IF EXISTS ${name} ON ${T(table)}`);
  }
  await q(`CREATE POLICY analytics_select ON ${T(table)} FOR SELECT USING (${READ_TENANT})`);
  await q(`CREATE POLICY analytics_insert ON ${T(table)} FOR INSERT WITH CHECK (${WRITER_ON} AND ${READ_TENANT})`);
  await q(`CREATE POLICY analytics_update ON ${T(table)} FOR UPDATE USING (${WRITER_ON} AND ${READ_TENANT}) WITH CHECK (${WRITER_ON} AND ${READ_TENANT})`);
  await q(`CREATE POLICY analytics_delete ON ${T(table)} FOR DELETE USING (${WRITER_ON} AND ${READ_TENANT})`);
}

module.exports = {
  up: async (queryInterface) => {
    const q = (sql) => queryInterface.sequelize.query(sql);
    await q(`CREATE SCHEMA IF NOT EXISTS "${SCHEMA}"`);
    for (const [table, keyDdl, keyNames, valueDdl] of TABLES) {
      await q(`
        CREATE TABLE IF NOT EXISTS ${T(table)} (
          company_id uuid NOT NULL REFERENCES "core"."companies"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
          group_id uuid NOT NULL REFERENCES "core"."groups"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
          ${[...keyDdl, ...valueDdl].join(',\n          ')},
          ${COMMON},
          CONSTRAINT ${table}_pk PRIMARY KEY (company_id, ${keyNames.map((n) => `"${n}"`).join(', ')})
        )
      `);
      await q(`CREATE INDEX IF NOT EXISTS ${table}_group_idx ON ${T(table)} (group_id)`);
      await applyRls(q, table);
    }
    const names = TABLES.map(([table]) => T(table)).join(', ');
    await q(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nayara_runtime') THEN
          GRANT USAGE ON SCHEMA "${SCHEMA}" TO nayara_runtime;
          GRANT SELECT, INSERT, UPDATE, DELETE ON ${names} TO nayara_runtime;
        END IF;
      END $$;
    `);
  },

  down: async (queryInterface) => {
    for (const [table] of [...TABLES].reverse()) await queryInterface.sequelize.query(`DROP TABLE IF EXISTS ${T(table)}`);
  },
};
