'use strict';

/**
 * Marco 9, demanda M9-D691 (Guia §7 e §16): colunas que o alert engine precisa em analytics.alert_instances.
 *
 *  - suppressed_count: quantas vezes a condição voltou durante o cooldown de uma instância RESOLVED (a nova ocorrência não cria alerta);
 *  - last_snapshot_id: o último snapshot avaliado (reavaliar o MESMO snapshot não muda estado nem contagem);
 *  - normal_streak: avaliações normais consecutivas (a política de resolução automática); uma avaliação anormal zera;
 *  - metric_code: a métrica do problema (o alerta de freshness tem uma instância por métrica; a listagem da M9-D703 também usa).
 *  - resolved_reason ganha DEFINITION_CHANGED: o limite ou a regra da definição mudou e a instância do limiar antigo foi encerrada.
 *
 * O gatilho da instância passa a deixar o worker de BI atualizar APENAS suppressed_count e last_snapshot_id numa instância RESOLVED (o resto do
 * registro resolvido continua imutável). SQL puro e idempotente. Faixa reservada: 9752 a 9759.
 */
const SCHEMA = 'analytics';
const T = (name) => `"${SCHEMA}"."${name}"`;
const USER_GUC = "NULLIF(current_setting('app.user_id', true), '')::uuid";

module.exports = {
  up: async (queryInterface) => {
    const q = (sql) => queryInterface.sequelize.query(sql);
    const [[base]] = await q("SELECT to_regprocedure('analytics.alert_instances_guard()') IS NOT NULL AS ok");
    if (!base.ok) throw new Error('Aplique antes a migration 20260101009602 (alertas do BI).');
    await q(`ALTER TABLE ${T('alert_instances')} ADD COLUMN IF NOT EXISTS suppressed_count integer NOT NULL DEFAULT 0`);
    await q(`ALTER TABLE ${T('alert_instances')} ADD COLUMN IF NOT EXISTS last_snapshot_id uuid NULL`);
    await q(`ALTER TABLE ${T('alert_instances')} ADD COLUMN IF NOT EXISTS normal_streak integer NOT NULL DEFAULT 0`);
    await q(`ALTER TABLE ${T('alert_instances')} ADD COLUMN IF NOT EXISTS metric_code text NULL`);
    await q(`ALTER TABLE ${T('alert_instances')} DROP CONSTRAINT IF EXISTS alert_instances_counts_nonneg`);
    await q(`ALTER TABLE ${T('alert_instances')} ADD CONSTRAINT alert_instances_counts_nonneg CHECK (suppressed_count >= 0 AND normal_streak >= 0)`);
    await q(`ALTER TABLE ${T('alert_instances')} DROP CONSTRAINT IF EXISTS alert_instances_reason_valid`);
    await q(`ALTER TABLE ${T('alert_instances')} ADD CONSTRAINT alert_instances_reason_valid CHECK (resolved_reason IS NULL OR resolved_reason IN ('CONDITION_NORMALIZED', 'DEFINITION_CHANGED'))`);
    await q(`ALTER TABLE ${T('alert_instances')} DROP CONSTRAINT IF EXISTS alert_instances_metric_code_format`);
    await q(`ALTER TABLE ${T('alert_instances')} ADD CONSTRAINT alert_instances_metric_code_format CHECK (metric_code IS NULL OR metric_code ~ '^[a-z][a-z0-9]*[.][a-z][a-z0-9_]*$')`);
    await q(`
      CREATE INDEX IF NOT EXISTS alert_instances_resolved_lookup_idx ON ${T('alert_instances')} (company_id, fingerprint, resolved_at DESC) WHERE status = 'RESOLVED'
    `);
    await q(`
      CREATE OR REPLACE FUNCTION ${SCHEMA}.alert_instances_guard() RETURNS trigger LANGUAGE plpgsql AS $fn$
      DECLARE
        writer boolean := COALESCE(current_setting('app.analytics_writer', true), '') = 'on';
        mutable text[] := ARRAY['status', 'severity', 'acknowledged_at', 'acknowledged_by', 'resolved_at', 'resolved_reason', 'last_evaluated_at',
                                'last_value', 'metric_snapshot_id', 'task_id', 'occurrence_count', 'cooldown_until', 'updated_at',
                                'suppressed_count', 'last_snapshot_id', 'normal_streak'];
        ack text[] := ARRAY['status', 'acknowledged_at', 'acknowledged_by', 'updated_at'];
        resolved_ok text[] := ARRAY['suppressed_count', 'last_snapshot_id', 'updated_at'];
      BEGIN
        IF (to_jsonb(NEW) - mutable) IS DISTINCT FROM (to_jsonb(OLD) - mutable) THEN
          RAISE EXCEPTION 'A identidade do alerta (definição, empresa, fingerprint) não muda.' USING ERRCODE = 'ANA11';
        END IF;
        IF OLD.status = 'RESOLVED' THEN
          -- instância resolvida é final; só o worker conta a supressão pelo cooldown (e guarda o snapshot que a suprimiu)
          IF NOT writer OR (to_jsonb(NEW) - resolved_ok) IS DISTINCT FROM (to_jsonb(OLD) - resolved_ok) THEN
            RAISE EXCEPTION 'Alerta resolvido não pode ser alterado; um novo disparo abre outro alerta.' USING ERRCODE = 'ANA11';
          END IF;
          RETURN NEW;
        END IF;
        IF NEW.status <> OLD.status AND NOT (OLD.status = 'OPEN' AND NEW.status IN ('ACKNOWLEDGED', 'RESOLVED')
                                             OR OLD.status = 'ACKNOWLEDGED' AND NEW.status = 'RESOLVED') THEN
          RAISE EXCEPTION 'Transição de estado de alerta inválida.' USING ERRCODE = 'ANA11';
        END IF;
        IF NOT writer THEN
          IF NOT (OLD.status = 'OPEN' AND NEW.status = 'ACKNOWLEDGED' AND NEW.acknowledged_by IS NOT DISTINCT FROM ${USER_GUC}
                  AND (to_jsonb(NEW) - ack) IS NOT DISTINCT FROM (to_jsonb(OLD) - ack)) THEN
            RAISE EXCEPTION 'Sem o worker de BI, só é permitido reconhecer um alerta aberto, em nome de quem reconhece.' USING ERRCODE = 'ANA11';
          END IF;
        END IF;
        RETURN NEW;
      END
      $fn$
    `);
  },

  down: async (queryInterface) => {
    const q = (sql) => queryInterface.sequelize.query(sql);
    await q(`DROP INDEX IF EXISTS ${T('alert_instances_resolved_lookup_idx')}`);
    await q(`ALTER TABLE ${T('alert_instances')} DROP CONSTRAINT IF EXISTS alert_instances_metric_code_format`);
    await q(`ALTER TABLE ${T('alert_instances')} DROP CONSTRAINT IF EXISTS alert_instances_counts_nonneg`);
    await q(`ALTER TABLE ${T('alert_instances')} DISABLE TRIGGER alert_instances_guard`); // a instância resolvida é imutável; o down precisa reescrever o motivo
    await q(`UPDATE ${T('alert_instances')} SET resolved_reason = 'CONDITION_NORMALIZED' WHERE resolved_reason = 'DEFINITION_CHANGED'`);
    await q(`ALTER TABLE ${T('alert_instances')} ENABLE TRIGGER alert_instances_guard`);
    await q(`ALTER TABLE ${T('alert_instances')} DROP CONSTRAINT IF EXISTS alert_instances_reason_valid`);
    await q(`ALTER TABLE ${T('alert_instances')} ADD CONSTRAINT alert_instances_reason_valid CHECK (resolved_reason IS NULL OR resolved_reason IN ('CONDITION_NORMALIZED'))`);
    for (const col of ['metric_code', 'normal_streak', 'last_snapshot_id', 'suppressed_count']) await q(`ALTER TABLE ${T('alert_instances')} DROP COLUMN IF EXISTS ${col}`);
  },
};
