'use strict';

/**
 * M9-D412 — ciclo de vida da campanha (MKT-009).
 *
 * 1. campaigns: meta, métrica e orçamento podem faltar enquanto a campanha é rascunho (o livro exige esses itens só para
 *    SCHEDULED, com 422 MKT_CAMPAIGN_INCOMPLETE); a partir de SCHEDULED o banco exige tudo (CHECK mkt_campaigns_scheduled_complete_chk).
 * 2. campaign_audience_members: a lista de pessoas materializada quando a campanha entra em SCHEDULED (o tamanho congela em
 *    campaign_audiences.size_frozen). Só referencia pessoas da empresa da campanha (a checagem cross-company é do serviço, DI-415).
 * 3. campaign_step_deliveries: um registro por step e destinatário, com action_key = sha256(campanha:step:pessoa) único por
 *    empresa (idempotência do disparo). Sem DELETE: nada se apaga.
 * 4. campaign_steps: status_reason (CAMPAIGN_ENDED, APPROVAL_INVALID, NO_ALLOWED_RECIPIENT...).
 *
 * Idempotente (IF NOT EXISTS). RLS ENABLE + FORCE por grupo e empresa; GRANT ao nayara_runtime dentro de guarda de existência.
 */

const NEW_TABLES = ['campaign_audience_members', 'campaign_step_deliveries'];
const POLICY = `USING (group_id = NULLIF(current_setting('app.group_id', true), '')::uuid
                 AND company_id = NULLIF(current_setting('app.company_id', true), '')::uuid)`;

module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql) => sequelize.query(sql, { transaction });

      for (const column of ['objective_metric', 'target_value', 'budget_amount']) {
        await q(`ALTER TABLE marketing.campaigns ALTER COLUMN ${column} DROP NOT NULL`);
      }
      await q('ALTER TABLE marketing.campaigns DROP CONSTRAINT IF EXISTS mkt_campaigns_scheduled_complete_chk');
      await q(`ALTER TABLE marketing.campaigns ADD CONSTRAINT mkt_campaigns_scheduled_complete_chk CHECK (
        status = 'DRAFT' OR (objective_metric IS NOT NULL AND target_value IS NOT NULL AND budget_amount IS NOT NULL
                             AND starts_at IS NOT NULL AND ends_at IS NOT NULL))`);

      await q('ALTER TABLE marketing.campaign_steps ADD COLUMN IF NOT EXISTS status_reason varchar(60) NULL');
      await q(`DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'mkt_campaign_audiences_id_company_uq') THEN
          ALTER TABLE marketing.campaign_audiences ADD CONSTRAINT mkt_campaign_audiences_id_company_uq UNIQUE (id, company_id);
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'mkt_campaign_steps_id_company_uq') THEN
          ALTER TABLE marketing.campaign_steps ADD CONSTRAINT mkt_campaign_steps_id_company_uq UNIQUE (id, company_id);
        END IF;
      END $$`);

      await q(`CREATE TABLE IF NOT EXISTS marketing.campaign_audience_members (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        group_id uuid NOT NULL REFERENCES core.groups(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        company_id uuid NOT NULL REFERENCES core.companies(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        campaign_id uuid NOT NULL,
        audience_id uuid NOT NULL,
        person_id uuid NOT NULL REFERENCES people.persons(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        created_by uuid NULL,
        CONSTRAINT mkt_campaign_audience_members_uq UNIQUE (audience_id, person_id),
        CONSTRAINT mkt_campaign_audience_members_campaign_fk FOREIGN KEY (campaign_id, company_id)
          REFERENCES marketing.campaigns (id, company_id) ON UPDATE CASCADE ON DELETE RESTRICT,
        CONSTRAINT mkt_campaign_audience_members_audience_fk FOREIGN KEY (audience_id, company_id)
          REFERENCES marketing.campaign_audiences (id, company_id) ON UPDATE CASCADE ON DELETE RESTRICT
      )`);
      await q('CREATE INDEX IF NOT EXISTS mkt_campaign_audience_members_campaign_idx ON marketing.campaign_audience_members (company_id, campaign_id, person_id)');
      await q('CREATE INDEX IF NOT EXISTS mkt_campaign_audience_members_person_idx ON marketing.campaign_audience_members (person_id)');

      await q(`CREATE TABLE IF NOT EXISTS marketing.campaign_step_deliveries (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        group_id uuid NOT NULL REFERENCES core.groups(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        company_id uuid NOT NULL REFERENCES core.companies(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        campaign_id uuid NOT NULL,
        step_id uuid NOT NULL,
        person_id uuid NOT NULL REFERENCES people.persons(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        action_key char(64) NOT NULL,
        status varchar(10) NOT NULL,
        reason varchar(80) NULL,
        external_ref varchar(300) NULL,
        processed_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        created_by uuid NULL,
        CONSTRAINT mkt_campaign_step_deliveries_action_uq UNIQUE (company_id, action_key),
        CONSTRAINT mkt_campaign_step_deliveries_step_person_uq UNIQUE (step_id, person_id),
        CONSTRAINT mkt_campaign_step_deliveries_key_chk CHECK (action_key ~ '^[0-9a-f]{64}$'),
        CONSTRAINT mkt_campaign_step_deliveries_status_chk CHECK (status IN ('SENT','BLOCKED','FAILED')),
        CONSTRAINT mkt_campaign_step_deliveries_campaign_fk FOREIGN KEY (campaign_id, company_id)
          REFERENCES marketing.campaigns (id, company_id) ON UPDATE CASCADE ON DELETE RESTRICT,
        CONSTRAINT mkt_campaign_step_deliveries_step_fk FOREIGN KEY (step_id, company_id)
          REFERENCES marketing.campaign_steps (id, company_id) ON UPDATE CASCADE ON DELETE RESTRICT
      )`);
      await q('CREATE INDEX IF NOT EXISTS mkt_campaign_step_deliveries_campaign_idx ON marketing.campaign_step_deliveries (company_id, campaign_id, status)');

      for (const t of NEW_TABLES) {
        await q(`ALTER TABLE marketing.${t} ENABLE ROW LEVEL SECURITY`);
        await q(`ALTER TABLE marketing.${t} FORCE ROW LEVEL SECURITY`);
        await q(`DROP POLICY IF EXISTS tenant_isolation ON marketing.${t}`);
        await q(`CREATE POLICY tenant_isolation ON marketing.${t} ${POLICY}`);
      }

      const [[{ exists }]] = await sequelize.query("SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nayara_runtime') AS exists", { transaction });
      if (exists) {
        await q('GRANT USAGE ON SCHEMA marketing TO nayara_runtime');
        // Sem DELETE: a lista congelada e o registro de disparo não se apagam.
        await q(`GRANT SELECT, INSERT ON ${NEW_TABLES.map((t) => `marketing.${t}`).join(', ')} TO nayara_runtime`);
      }
    });
  },

  async down(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql) => sequelize.query(sql, { transaction });
      for (const t of [...NEW_TABLES].reverse()) {
        const [[{ reg }]] = await sequelize.query(`SELECT to_regclass('marketing.${t}') AS reg`, { transaction });
        if (!reg) continue;
        const [[{ n }]] = await sequelize.query(`SELECT count(*)::int AS n FROM marketing.${t}`, { transaction });
        if (n > 0) throw new Error(`MKT_MIGRATION_DOWN_NOT_EMPTY: marketing.${t} não está vazia (${n} linhas); o down não apaga dados.`);
        await q(`DROP TABLE marketing.${t}`);
      }
      await q('ALTER TABLE marketing.campaigns DROP CONSTRAINT IF EXISTS mkt_campaigns_scheduled_complete_chk');
      await q('ALTER TABLE marketing.campaign_steps DROP COLUMN IF EXISTS status_reason');
      await q('ALTER TABLE marketing.campaign_steps DROP CONSTRAINT IF EXISTS mkt_campaign_steps_id_company_uq');
      await q('ALTER TABLE marketing.campaign_audiences DROP CONSTRAINT IF EXISTS mkt_campaign_audiences_id_company_uq');
      const [[{ nulos }]] = await sequelize.query(
        'SELECT count(*)::int AS nulos FROM marketing.campaigns WHERE objective_metric IS NULL OR target_value IS NULL OR budget_amount IS NULL', { transaction });
      if (nulos > 0) throw new Error(`MKT_MIGRATION_DOWN_NOT_EMPTY: ${nulos} campanha(s) em rascunho sem meta, métrica ou orçamento; complete-as antes de reverter.`);
      for (const column of ['objective_metric', 'target_value', 'budget_amount']) {
        await q(`ALTER TABLE marketing.campaigns ALTER COLUMN ${column} SET NOT NULL`);
      }
    });
  },
};
