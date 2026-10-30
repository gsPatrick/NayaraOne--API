'use strict';

/**
 * M9-D911 — governance.retention_policies: a política de retenção por empresa. Os cinco elementos do livro existem em toda linha: prazo (retention_months),
 * gatilho (trigger), base legal (legal_basis_code, legal_basis_text e reference_text), disposição (disposition) e exceções (exceptions, sempre com LEGAL_HOLD).
 * retention_months = 0 só com disposição REVIEW (o item vira revisão assim que o gatilho ocorre; nunca se apaga sozinho). data_types lista os tipos de dado
 * (alvos do catálogo retention.targets.js) que a política governa. auto_apply liga a aplicação automática do job (só para alvos tecnicamente seguros, regra do serviço).
 * RLS + FORCE pela função do alicerce (M9-D800). Reversível.
 */
const TRIGGERS = ['CONTRACT_END', 'TRANSACTION_DATE', 'PERSON_INACTIVE_SINCE', 'CASE_CLOSED', 'UPLOAD_DATE', 'LEAD_LAST_CONTACT', 'FISCAL_PERIOD_END'];
const DISPOSITIONS = ['DELETE', 'ANONYMIZE', 'ARCHIVE', 'REVIEW'];
const list = (items) => items.map((item) => `'${item}'`).join(', ');

module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql) => sequelize.query(sql, { transaction });
      await q(`CREATE TABLE IF NOT EXISTS governance.retention_policies (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        group_id uuid NOT NULL REFERENCES core.groups(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        company_id uuid NOT NULL REFERENCES core.companies(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        code varchar(40) NOT NULL,
        name varchar(120) NOT NULL,
        retention_months integer NOT NULL,
        trigger varchar(30) NOT NULL,
        legal_basis_code varchar(60) NOT NULL,
        legal_basis_text text NOT NULL,
        reference_text text NOT NULL,
        disposition varchar(10) NOT NULL,
        exceptions jsonb NOT NULL DEFAULT '["LEGAL_HOLD"]'::jsonb,
        data_types jsonb NOT NULL DEFAULT '[]'::jsonb,
        owner_domain varchar(40) NOT NULL,
        version integer NOT NULL DEFAULT 1,
        approved_by uuid NULL REFERENCES core.users(id) ON UPDATE CASCADE ON DELETE SET NULL,
        approved_at timestamptz NULL,
        auto_apply boolean NOT NULL DEFAULT false,
        is_seed boolean NOT NULL DEFAULT false,
        created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT gov_ret_pol_code_uq UNIQUE (company_id, code),
        CONSTRAINT gov_ret_pol_code_chk CHECK (code ~ '^[A-Z][A-Z0-9_]*$'),
        CONSTRAINT gov_ret_pol_months_chk CHECK (retention_months >= 0 AND retention_months <= 1200),
        CONSTRAINT gov_ret_pol_trigger_chk CHECK (trigger IN (${list(TRIGGERS)})),
        CONSTRAINT gov_ret_pol_disp_chk CHECK (disposition IN (${list(DISPOSITIONS)})),
        CONSTRAINT gov_ret_pol_zero_chk CHECK (retention_months > 0 OR disposition = 'REVIEW'),
        CONSTRAINT gov_ret_pol_hold_chk CHECK (jsonb_typeof(exceptions) = 'array' AND exceptions @> '["LEGAL_HOLD"]'::jsonb),
        CONSTRAINT gov_ret_pol_types_chk CHECK (jsonb_typeof(data_types) = 'array'),
        CONSTRAINT gov_ret_pol_basis_chk CHECK (length(btrim(legal_basis_code)) > 0 AND length(btrim(reference_text)) > 0)
      )`);
      await q("SELECT governance.apply_tenant_rls('governance.retention_policies'::regclass)");
    });
  },
  async down(queryInterface) {
    await queryInterface.sequelize.query('DROP TABLE IF EXISTS governance.retention_policies');
  },
};
