'use strict';

const { applyLegalTenantRls } = require('./_helpers/legalTenantTable');

/**
 * Fechamento M5 (vistorias e prazos) — ciclo das obrigações da locação (livro §12 "Cada obrigação possui responsável,
 * periodicidade, comprovante e status" e "Pendência gera alerta/cobrança; não some quando contrato encerra"; M5-A0096,
 * M5-A0171, M5-A0187, M5-A0248, M5-A0270; DEC-074).
 *  - legal.lease_obligation_cycles: um ciclo por vencimento de cada obrigação (UNIQUE obrigação + vencimento), com status
 *    OPEN -> PAID | OVERDUE -> PAID | WAIVED, comprovante (arquivo real da empresa, um comprovante não serve a dois ciclos),
 *    quem pagou, valor, reembolso gerado e a tarefa de cobrança aberta no atraso. Append-only na prática: não há DELETE para o
 *    runtime; o ciclo vencido continua lá depois do encerramento do contrato.
 *  - o pagamento de um ciclo é único (a chave natural do pagamento é o ciclo): repetir o envio não cria segundo reembolso.
 * Não muda dado existente (tabela nova). Reversível (a volta apaga a tabela nova).
 */
module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql) => sequelize.query(sql, { transaction });
      await q(`CREATE TABLE IF NOT EXISTS legal.lease_obligation_cycles (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        group_id uuid NOT NULL REFERENCES core.groups(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        company_id uuid NOT NULL REFERENCES core.companies(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        obligation_id uuid NOT NULL REFERENCES legal.lease_obligations(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        contract_id uuid NOT NULL REFERENCES legal.contracts(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        due_on date NOT NULL,
        status varchar(16) NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'OVERDUE', 'PAID', 'WAIVED')),
        paid_at timestamptz NULL,
        paid_by_party varchar(16) NULL,
        amount numeric(18,2) NULL CHECK (amount IS NULL OR amount > 0),
        proof_file_id uuid NULL REFERENCES people.files(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        reimbursement_id uuid NULL REFERENCES finance.utility_reimbursements(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        overdue_since timestamptz NULL,
        collection_task_id uuid NULL,
        waived_reason text NULL,
        created_by uuid NULL,
        updated_by uuid NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        lock_version integer NOT NULL DEFAULT 0,
        CONSTRAINT lease_obligation_cycles_due_uq UNIQUE (obligation_id, due_on),
        CONSTRAINT lease_obligation_cycles_paid_chk CHECK (status <> 'PAID' OR (paid_at IS NOT NULL AND proof_file_id IS NOT NULL))
      )`);
      await q(`CREATE UNIQUE INDEX IF NOT EXISTS lease_obligation_cycles_proof_uq ON legal.lease_obligation_cycles (proof_file_id) WHERE proof_file_id IS NOT NULL`);
      await q('CREATE INDEX IF NOT EXISTS lease_obligation_cycles_open_idx ON legal.lease_obligation_cycles (company_id, status, due_on)');
      await q('CREATE INDEX IF NOT EXISTS lease_obligation_cycles_contract_idx ON legal.lease_obligation_cycles (contract_id)');
      await applyLegalTenantRls(q, 'legal.lease_obligation_cycles', 'SELECT, INSERT, UPDATE');
    });
  },

  async down(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      await sequelize.query('DROP TABLE IF EXISTS legal.lease_obligation_cycles', { transaction });
    });
  },
};
