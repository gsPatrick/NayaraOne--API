'use strict';

/**
 * M9-D833 — governance.bcp_payment_pendings: a pendência de conciliação do pagamento emergencial com o extrato bancário. Nasce OPEN na importação, com o valor em centavos, a data
 * da operação e o prazo (`deadline_on`, em dias úteis a partir dela); vira MATCHED ao casar com uma linha de finance.bank_transactions (cada linha casa com uma só pendência) ou
 * CANCELED se a divergência for estornada. `last_alert_key` guarda a chave do último alerta (`bcp.payment_unreconciled:<referência>:<AAAA-MM-DD>`): um alerta por operação e dia.
 * RLS + FORCE pela função do alicerce (M9-D800). Reversível.
 */
module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql) => sequelize.query(sql, { transaction });
      await q(`CREATE TABLE IF NOT EXISTS governance.bcp_payment_pendings (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        group_id uuid NOT NULL REFERENCES core.groups(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        company_id uuid NOT NULL REFERENCES core.companies(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        manual_operation_id uuid NOT NULL REFERENCES governance.manual_operations(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        manual_reference varchar(20) NOT NULL,
        amount_cents bigint NOT NULL,
        occurred_on date NOT NULL,
        deadline_on date NOT NULL,
        imported_by uuid NOT NULL REFERENCES core.users(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        status varchar(10) NOT NULL DEFAULT 'OPEN',
        bank_transaction_id uuid NULL REFERENCES finance.bank_transactions(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        matched_at timestamptz NULL,
        last_alert_key varchar(80) NULL,
        last_alerted_at timestamptz NULL,
        created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT gov_payment_pending_op_uq UNIQUE (manual_operation_id),
        CONSTRAINT gov_payment_pending_line_uq UNIQUE (bank_transaction_id),
        CONSTRAINT gov_payment_pending_status_chk CHECK (status IN ('OPEN', 'MATCHED', 'CANCELED')),
        CONSTRAINT gov_payment_pending_amount_chk CHECK (amount_cents > 0),
        CONSTRAINT gov_payment_pending_match_chk CHECK ((status = 'MATCHED') = (bank_transaction_id IS NOT NULL))
      )`);
      await q('CREATE INDEX IF NOT EXISTS gov_payment_pending_open_idx ON governance.bcp_payment_pendings (company_id, status, deadline_on)');
      await q("SELECT governance.apply_tenant_rls('governance.bcp_payment_pendings'::regclass)");
    });
  },
  async down(queryInterface) {
    await queryInterface.sequelize.query('DROP TABLE IF EXISTS governance.bcp_payment_pendings');
  },
};
