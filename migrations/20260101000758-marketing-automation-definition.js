'use strict';

/**
 * M9-D413 — definição da AutomationVersion (MKT-006).
 *
 * 1. automation_versions.conditions_empty_reason: justificativa de quem publica automação sem condições (obrigatória quando
 *    `conditions` é vazia). Faz parte do conteúdo da versão, então entra na imutabilidade da versão não-rascunho.
 * 2. Índice único condicional: no máximo UMA versão "viva" (PUBLISHED ou PAUSED) por fluxo. Publicar a próxima exige aposentar
 *    (SUPERSEDED) a anterior na mesma transação; duas publicações concorrentes não coexistem.
 * 3. Função automation_versions_immutable: acrescenta conditions_empty_reason (CREATE OR REPLACE, idempotente).
 *
 * Sem tabela nova (RLS e GRANT já existem desde a 751; coluna nova herda o GRANT da tabela).
 */
module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql) => sequelize.query(sql, { transaction });
      await q('ALTER TABLE marketing.automation_versions ADD COLUMN IF NOT EXISTS conditions_empty_reason text NULL');
      await q(`CREATE UNIQUE INDEX IF NOT EXISTS mkt_automation_versions_one_live_uq
        ON marketing.automation_versions (flow_id) WHERE status IN ('PUBLISHED','PAUSED') AND deleted_at IS NULL`);
      await q(`CREATE OR REPLACE FUNCTION marketing.automation_versions_immutable() RETURNS trigger
        LANGUAGE plpgsql AS $fn$
        BEGIN
          IF OLD.status <> 'DRAFT' AND (
               NEW.status = 'DRAFT'
            OR NEW.flow_id IS DISTINCT FROM OLD.flow_id
            OR NEW.version_no IS DISTINCT FROM OLD.version_no
            OR NEW.trigger_type IS DISTINCT FROM OLD.trigger_type
            OR NEW.trigger_config IS DISTINCT FROM OLD.trigger_config
            OR NEW.conditions IS DISTINCT FROM OLD.conditions
            OR NEW.conditions_empty_reason IS DISTINCT FROM OLD.conditions_empty_reason
            OR NEW.actions IS DISTINCT FROM OLD.actions
            OR NEW.cooldown IS DISTINCT FROM OLD.cooldown
            OR NEW.frequency_cap IS DISTINCT FROM OLD.frequency_cap
            OR NEW.valid_from IS DISTINCT FROM OLD.valid_from
            OR NEW.valid_until IS DISTINCT FROM OLD.valid_until
            OR NEW.risk_level IS DISTINCT FROM OLD.risk_level
            OR NEW.content_hash IS DISTINCT FROM OLD.content_hash) THEN
            RAISE EXCEPTION 'MKT_AUTOMATION_VERSION_IMMUTABLE: a versão publicada é imutável; crie uma nova versão.' USING ERRCODE = 'MK003';
          END IF;
          RETURN NEW;
        END
        $fn$`);
    });
  },

  async down(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql) => sequelize.query(sql, { transaction });
      const [[{ n }]] = await sequelize.query(
        'SELECT count(*)::int AS n FROM marketing.automation_versions WHERE conditions_empty_reason IS NOT NULL', { transaction });
      if (n > 0) throw new Error(`MKT_MIGRATION_DOWN_NOT_EMPTY: ${n} versão(ões) de automação com justificativa de condições vazias; o down não apaga dados.`);
      await q('DROP INDEX IF EXISTS marketing.mkt_automation_versions_one_live_uq');
      await q(`CREATE OR REPLACE FUNCTION marketing.automation_versions_immutable() RETURNS trigger
        LANGUAGE plpgsql AS $fn$
        BEGIN
          IF OLD.status <> 'DRAFT' AND (
               NEW.status = 'DRAFT'
            OR NEW.flow_id IS DISTINCT FROM OLD.flow_id
            OR NEW.version_no IS DISTINCT FROM OLD.version_no
            OR NEW.trigger_type IS DISTINCT FROM OLD.trigger_type
            OR NEW.trigger_config IS DISTINCT FROM OLD.trigger_config
            OR NEW.conditions IS DISTINCT FROM OLD.conditions
            OR NEW.actions IS DISTINCT FROM OLD.actions
            OR NEW.cooldown IS DISTINCT FROM OLD.cooldown
            OR NEW.frequency_cap IS DISTINCT FROM OLD.frequency_cap
            OR NEW.valid_from IS DISTINCT FROM OLD.valid_from
            OR NEW.valid_until IS DISTINCT FROM OLD.valid_until
            OR NEW.risk_level IS DISTINCT FROM OLD.risk_level
            OR NEW.content_hash IS DISTINCT FROM OLD.content_hash) THEN
            RAISE EXCEPTION 'MKT_AUTOMATION_VERSION_IMMUTABLE: a versão publicada é imutável; crie uma nova versão.' USING ERRCODE = 'MK003';
          END IF;
          RETURN NEW;
        END
        $fn$`);
      await q('ALTER TABLE marketing.automation_versions DROP COLUMN IF EXISTS conditions_empty_reason');
    });
  },
};
