'use strict';

/**
 * Marco 9, campanha de e-mail (verificação K=7, item 5) — falha transitória do provedor não vira perda definitiva.
 *
 * campaign_step_deliveries passa a ter os estados ABERTOS da entrega por destinatário (INT-005, INT-006 e §7/§8 do bloco de Integrações):
 *  - RETRY: falha transitória (429, 5xx, cofre fora por um instante); nova tentativa em next_attempt_at, com backoff e limite (M9-D216);
 *  - UNKNOWN: resultado incerto (timeout); nada é reenviado antes de reconciliar com o provedor pela chave de idempotência (M9-D215);
 *  - CANCELLED: a campanha encerrou (ou o step foi pulado) com a entrega ainda aberta: nada saiu e nada mais sai.
 * Colunas: attempts (envios tentados), rate_deferrals (adiamentos seguidos por limite do fornecedor), reconcile_attempts (consultas do UNKNOWN),
 * next_attempt_at (obrigatório nos abertos, proibido nos fechados: nada fica aberto sem hora para voltar) e updated_at.
 * UPDATE passa a ser concedido ao nayara_runtime, mas o gatilho só deixa mudar linha ABERTA (RETRY/UNKNOWN) ou FAILED (reprocessar, ação do administrador
 * com auditoria) e nunca a identidade da linha (empresa, campanha, step, pessoa, action_key). SENT e CANCELLED são finais; BLOCKED também, salvo o
 * legado CANSEND_ERROR (falha passageira do canSend gravada como bloqueio antes desta correção). Continua sem DELETE.
 * Idempotente; o down recusa se houver linha nos estados novos (não apaga dados).
 */

const TABLE = 'marketing.campaign_step_deliveries';
const OPEN = "('RETRY','UNKNOWN')";

module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql) => sequelize.query(sql, { transaction });
      await q(`ALTER TABLE ${TABLE}
        ADD COLUMN IF NOT EXISTS attempts smallint NOT NULL DEFAULT 1,
        ADD COLUMN IF NOT EXISTS rate_deferrals integer NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS reconcile_attempts smallint NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS next_attempt_at timestamptz NULL,
        ADD COLUMN IF NOT EXISTS updated_at timestamptz NULL`);
      await q(`ALTER TABLE ${TABLE} DROP CONSTRAINT IF EXISTS mkt_campaign_step_deliveries_status_chk`);
      await q(`ALTER TABLE ${TABLE} ADD CONSTRAINT mkt_campaign_step_deliveries_status_chk CHECK (status IN ('SENT','BLOCKED','FAILED','RETRY','UNKNOWN','CANCELLED'))`);
      await q(`ALTER TABLE ${TABLE} DROP CONSTRAINT IF EXISTS mkt_campaign_step_deliveries_next_chk`);
      await q(`ALTER TABLE ${TABLE} ADD CONSTRAINT mkt_campaign_step_deliveries_next_chk CHECK ((status IN ${OPEN}) = (next_attempt_at IS NOT NULL))`);
      await q(`ALTER TABLE ${TABLE} DROP CONSTRAINT IF EXISTS mkt_campaign_step_deliveries_counts_chk`);
      await q(`ALTER TABLE ${TABLE} ADD CONSTRAINT mkt_campaign_step_deliveries_counts_chk CHECK (attempts >= 0 AND rate_deferrals >= 0 AND reconcile_attempts >= 0)`);
      await q(`CREATE INDEX IF NOT EXISTS mkt_campaign_step_deliveries_open_idx ON ${TABLE} (company_id, step_id, next_attempt_at) WHERE status IN ${OPEN}`);

      await q(`CREATE OR REPLACE FUNCTION marketing.mkt_campaign_step_deliveries_guard() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.group_id IS DISTINCT FROM OLD.group_id OR NEW.company_id IS DISTINCT FROM OLD.company_id OR NEW.campaign_id IS DISTINCT FROM OLD.campaign_id
             OR NEW.step_id IS DISTINCT FROM OLD.step_id OR NEW.person_id IS DISTINCT FROM OLD.person_id OR NEW.action_key IS DISTINCT FROM OLD.action_key THEN
            RAISE EXCEPTION 'MKT_DELIVERY_IDENTITY: a identidade da entrega da campanha não muda.' USING ERRCODE = 'check_violation';
          END IF;
          IF OLD.status IN ('SENT','CANCELLED') OR (OLD.status = 'BLOCKED' AND OLD.reason IS DISTINCT FROM 'CANSEND_ERROR') THEN
            RAISE EXCEPTION 'MKT_DELIVERY_FINAL: entrega % é final e não muda.', OLD.status USING ERRCODE = 'check_violation';
          END IF;
          NEW.updated_at := now();
          RETURN NEW;
        END $$`);
      await q(`DROP TRIGGER IF EXISTS mkt_campaign_step_deliveries_guard_trg ON ${TABLE}`);
      await q(`CREATE TRIGGER mkt_campaign_step_deliveries_guard_trg BEFORE UPDATE ON ${TABLE} FOR EACH ROW EXECUTE FUNCTION marketing.mkt_campaign_step_deliveries_guard()`);

      const [[{ exists }]] = await sequelize.query("SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nayara_runtime') AS exists", { transaction });
      if (exists) await q(`GRANT UPDATE ON ${TABLE} TO nayara_runtime`);
    });
  },

  async down(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql) => sequelize.query(sql, { transaction });
      const [[{ reg }]] = await sequelize.query(`SELECT to_regclass('${TABLE}') AS reg`, { transaction });
      if (!reg) return;
      const [[{ n }]] = await sequelize.query(`SELECT count(*)::int AS n FROM ${TABLE} WHERE status IN ('RETRY','UNKNOWN','CANCELLED')`, { transaction });
      if (n > 0) throw new Error(`MKT_MIGRATION_DOWN_NOT_EMPTY: ${n} entrega(s) de campanha em RETRY, UNKNOWN ou CANCELLED; o down não apaga dados.`);
      const [[{ exists }]] = await sequelize.query("SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nayara_runtime') AS exists", { transaction });
      if (exists) await q(`REVOKE UPDATE ON ${TABLE} FROM nayara_runtime`);
      await q(`DROP TRIGGER IF EXISTS mkt_campaign_step_deliveries_guard_trg ON ${TABLE}`);
      await q('DROP FUNCTION IF EXISTS marketing.mkt_campaign_step_deliveries_guard()');
      await q('DROP INDEX IF EXISTS marketing.mkt_campaign_step_deliveries_open_idx');
      for (const c of ['next_chk', 'counts_chk', 'status_chk']) await q(`ALTER TABLE ${TABLE} DROP CONSTRAINT IF EXISTS mkt_campaign_step_deliveries_${c}`);
      await q(`ALTER TABLE ${TABLE} ADD CONSTRAINT mkt_campaign_step_deliveries_status_chk CHECK (status IN ('SENT','BLOCKED','FAILED'))`);
      await q(`ALTER TABLE ${TABLE} DROP COLUMN IF EXISTS attempts, DROP COLUMN IF EXISTS rate_deferrals, DROP COLUMN IF EXISTS reconcile_attempts,
        DROP COLUMN IF EXISTS next_attempt_at, DROP COLUMN IF EXISTS updated_at`);
    });
  },
};
