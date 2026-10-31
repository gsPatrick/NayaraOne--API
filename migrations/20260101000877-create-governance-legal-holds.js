'use strict';

/**
 * M9-D912 — governance.legal_holds: a trava jurídica (legal hold). Uma linha por retenção legal da empresa: código único, motivo, referência do processo, escopo (JSON com os
 * itens que o definem), situação ACTIVE ou RELEASED e quem criou e liberou. A trava é prova: o gatilho recusa apagar uma retenção ativa, mudar código, motivo, referência,
 * escopo ou autor, e reabrir uma retenção liberada; a única mudança permitida é liberar (RELEASED com motivo e quem liberou). RLS + FORCE (M9-D800). Reversível.
 */
module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql) => sequelize.query(sql, { transaction });
      await q(`CREATE TABLE IF NOT EXISTS governance.legal_holds (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        group_id uuid NOT NULL REFERENCES core.groups(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        company_id uuid NOT NULL REFERENCES core.companies(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        code varchar(40) NOT NULL,
        reason text NOT NULL,
        matter_ref varchar(120) NOT NULL,
        scope jsonb NOT NULL,
        status varchar(10) NOT NULL DEFAULT 'ACTIVE',
        created_by uuid NULL REFERENCES core.users(id) ON UPDATE CASCADE ON DELETE SET NULL,
        created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        released_by uuid NULL REFERENCES core.users(id) ON UPDATE CASCADE ON DELETE SET NULL,
        released_at timestamptz NULL,
        release_reason text NULL,
        CONSTRAINT gov_hold_code_uq UNIQUE (company_id, code),
        CONSTRAINT gov_hold_status_chk CHECK (status IN ('ACTIVE', 'RELEASED')),
        CONSTRAINT gov_hold_scope_chk CHECK (jsonb_typeof(scope) = 'array' AND jsonb_array_length(scope) > 0),
        CONSTRAINT gov_hold_release_chk CHECK ((status = 'ACTIVE' AND released_at IS NULL AND release_reason IS NULL) OR (status = 'RELEASED' AND released_at IS NOT NULL AND release_reason IS NOT NULL))
      )`);
      await q('CREATE INDEX IF NOT EXISTS gov_hold_status_idx ON governance.legal_holds (company_id, status)');
      await q(`CREATE OR REPLACE FUNCTION governance.guard_legal_hold_change() RETURNS trigger LANGUAGE plpgsql AS $fn$
        BEGIN
          IF TG_OP = 'DELETE' THEN
            IF OLD.status = 'ACTIVE' THEN RAISE EXCEPTION 'Uma retenção legal ativa não pode ser apagada; libere-a com motivo.' USING ERRCODE = '23001'; END IF;
            RETURN OLD;
          END IF;
          IF OLD.status = 'RELEASED' THEN RAISE EXCEPTION 'Uma retenção legal liberada não pode ser alterada.' USING ERRCODE = '23001'; END IF;
          IF NEW.code IS DISTINCT FROM OLD.code OR NEW.reason IS DISTINCT FROM OLD.reason OR NEW.matter_ref IS DISTINCT FROM OLD.matter_ref OR NEW.scope IS DISTINCT FROM OLD.scope
             OR NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.company_id IS DISTINCT FROM OLD.company_id THEN
            RAISE EXCEPTION 'Código, motivo, referência, escopo e autor da retenção legal não mudam; só a liberação.' USING ERRCODE = '23001';
          END IF;
          RETURN NEW;
        END $fn$`);
      await q('DROP TRIGGER IF EXISTS gov_hold_guard ON governance.legal_holds');
      await q('CREATE TRIGGER gov_hold_guard BEFORE UPDATE OR DELETE ON governance.legal_holds FOR EACH ROW EXECUTE FUNCTION governance.guard_legal_hold_change()');
      await q("SELECT governance.apply_tenant_rls('governance.legal_holds'::regclass)");
    });
  },
  async down(queryInterface) {
    await queryInterface.sequelize.query('DROP TABLE IF EXISTS governance.legal_holds CASCADE');
    await queryInterface.sequelize.query('DROP FUNCTION IF EXISTS governance.guard_legal_hold_change()');
  },
};
