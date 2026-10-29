'use strict';

/**
 * Marco 9, demanda M9-D627 (Caderno "Dashboards + BI + Centro de Comando", §11 KPIs Marketing/Atendimento): read models de Marketing e
 * Atendimento/Satisfação no schema analytics. Por EMPRESA, só ids e agregados (nenhum telefone, e-mail, nome ou documento).
 *
 *  rm_mkt_campaigns           custo, leads e leads atribuídos por campanha
 *  rm_mkt_delivery            enviadas, entregues, falhas e opt-out por dia e canal
 *  rm_mkt_frequency           contatos alcançados e contatos acima do teto de frequência por dia
 *  rm_mkt_reviews             avaliações públicas concluídas e soma das notas por mês e plataforma
 *  rm_mkt_automation          execuções, bloqueios e falhas das automações por dia
 *  rm_support_satisfaction    respostas de satisfação e soma das notas por mês
 *  rm_support_complaints      reclamações por mês e motivo
 *  rm_support_sla             resolvidos, resolvidos no prazo e vencidos em aberto por mês
 *
 * RLS ENABLE + FORCE: leitura pelas GUCs de empresa/grupo; escrita só com app.analytics_writer = 'on' (worker de read models, M9-D607).
 * GRANT ao nayara_runtime só se o role existir. Idempotente. Faixa reservada: 9733 a 9740.
 */
const SCHEMA = 'analytics';
const COMPANY_GUC = "NULLIF(current_setting('app.company_id', true), '')::uuid";
const GROUP_GUC = "NULLIF(current_setting('app.group_id', true), '')::uuid";
const WRITER_ON = "COALESCE(current_setting('app.analytics_writer', true), '') = 'on'";
const READ_TENANT = `(company_id = ${COMPANY_GUC} AND group_id = ${GROUP_GUC})`;
const T = (name) => `"${SCHEMA}"."${name}"`;
const COUNT = (name) => `"${name}" integer NOT NULL DEFAULT 0 CHECK ("${name}" >= 0)`;
const MONTH = 'month varchar(7) NOT NULL CHECK (month ~ \'^[0-9]{4}-(0[1-9]|1[0-2])$\')';

const COMMON = `
  source_snapshot_at timestamptz,
  refreshed_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1)`;

const TABLES = [
  { name: 'rm_mkt_campaigns', key: ['campaign_id'], columns: ['campaign_id uuid NOT NULL', 'cost_total numeric(18,2) NOT NULL DEFAULT 0', COUNT('leads_total'), COUNT('attributed_leads')] },
  { name: 'rm_mkt_delivery', key: ['day', 'channel'], columns: ['day date NOT NULL', 'channel varchar(16) NOT NULL', COUNT('sent'), COUNT('delivered'), COUNT('failed'), COUNT('opt_out')] },
  { name: 'rm_mkt_frequency', key: ['day'], columns: ['day date NOT NULL', COUNT('contacts_reached'), COUNT('contacts_over_cap')] },
  { name: 'rm_mkt_reviews', key: ['month', 'platform'], columns: [MONTH, 'platform varchar(40) NOT NULL', COUNT('reviews'), COUNT('rating_sum')] },
  { name: 'rm_mkt_automation', key: ['day'], columns: ['day date NOT NULL', COUNT('executed'), COUNT('blocked'), COUNT('failed')] },
  { name: 'rm_support_satisfaction', key: ['month'], columns: [MONTH, COUNT('responses'), COUNT('score_sum')] },
  { name: 'rm_support_complaints', key: ['month', 'reason'], columns: [MONTH, 'reason varchar(40) NOT NULL', COUNT('count')] },
  { name: 'rm_support_sla', key: ['month'], columns: [MONTH, COUNT('resolved'), COUNT('within_sla'), COUNT('open_overdue')] },
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
    for (const t of TABLES) {
      await q(`
        CREATE TABLE IF NOT EXISTS ${T(t.name)} (
          company_id uuid NOT NULL REFERENCES "core"."companies"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
          group_id uuid NOT NULL REFERENCES "core"."groups"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
          ${t.columns.join(',\n          ')},
          ${COMMON},
          CONSTRAINT ${t.name}_pk PRIMARY KEY (company_id, ${t.key.join(', ')})
        )
      `);
      await q(`CREATE INDEX IF NOT EXISTS ${t.name}_group_idx ON ${T(t.name)} (group_id)`);
      await applyRls(q, t.name);
    }
    const names = TABLES.map((t) => T(t.name)).join(', ');
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
    for (const t of [...TABLES].reverse()) await queryInterface.sequelize.query(`DROP TABLE IF EXISTS ${T(t.name)}`);
  },
};
