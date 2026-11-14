'use strict';

/**
 * M45 (19/10/2026) — cruzamento do Caderno do Marco 4 linha a linha.
 * §12 "Desconto precisa de motivo/documento/regra": o repasse ao proprietário passa a guardar o
 * MOTIVO das deduções (obrigatório quando há dedução > 0, exigido no serviço e por CHECK no banco
 * para linhas novas) e, opcionalmente, o documento que as comprova.
 *
 * §5 "Entidades/tabelas obrigatórias": o modelo físico guarda o fato realizado em
 * finance.financial_entries (linhas SETTLED/REVERSED imutáveis por trigger — F3-LG), as parcelas
 * como filhas (parent_entry_id) e a caução/dinheiro de terceiros como lançamentos marcados
 * (is_third_party_funds + origem/titular imutáveis — F04). Para que os nomes do caderno existam
 * no banco, criamos VIEWS somente leitura com os nomes literais: finance.ledger,
 * finance.entry_installments, finance.security_deposits, finance.accounts_chart e
 * finance.closing_periods. security_invoker = true: a RLS das tabelas de origem vale para quem
 * consulta (uma empresa nunca vê a outra pela view). Escrita na view é recusada por trigger.
 */
module.exports = {
  async up(queryInterface) {
    const q = (sql) => queryInterface.sequelize.query(sql);
    await q(`ALTER TABLE finance.owner_repasses
               ADD COLUMN IF NOT EXISTS deductions_reason text NULL,
               ADD COLUMN IF NOT EXISTS deductions_document_file_id uuid NULL`);
    // NOT VALID: não reprova linhas antigas (anteriores à regra); vale para toda linha nova/alterada.
    await q(`DO $$ BEGIN
               IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'owner_repasses_deduction_reason_chk') THEN
                 ALTER TABLE finance.owner_repasses ADD CONSTRAINT owner_repasses_deduction_reason_chk
                   CHECK (deductions_amount = 0 OR (deductions_reason IS NOT NULL AND length(btrim(deductions_reason)) > 0)) NOT VALID;
               END IF;
             END $$`);
    await q(`CREATE OR REPLACE FUNCTION finance.caderno_view_read_only() RETURNS trigger LANGUAGE plpgsql AS $f$
             BEGIN
               RAISE EXCEPTION 'A view %.% é somente leitura (nomes do Caderno M4 §5); escreva pelo serviço do Financeiro.', TG_TABLE_SCHEMA, TG_TABLE_NAME
                 USING ERRCODE = '42501';
             END $f$`);
    const views = {
      ledger: `SELECT e.id, e.group_id, e.company_id, COALESCE(e.parent_entry_id, e.id) AS financial_entry_id,
                      e.bank_account_id,
                      CASE WHEN e.reversal_of_entry_id IS NOT NULL THEN 'REVERSAL'
                           WHEN e.parent_entry_id IS NOT NULL THEN 'PARTIAL_' || e.nature
                           ELSE e.nature END AS movement_type,
                      e.entry_type AS direction, e.amount, 'BRL'::char(3) AS currency, e.idempotency_key,
                      e.settled_at AS occurred_at, e.reversal_of_entry_id AS reverses_ledger_id,
                      e.is_third_party_funds, e.created_by, e.created_at
                 FROM finance.financial_entries e
                WHERE e.status IN ('SETTLED', 'REVERSED') AND e.settled_at IS NOT NULL
                  AND NOT EXISTS (SELECT 1 FROM finance.financial_entries c WHERE c.parent_entry_id = e.id)`,
      entry_installments: `SELECT c.id, c.group_id, c.company_id, c.parent_entry_id AS financial_entry_id, c.amount,
                                  c.due_at, c.settled_at, c.status, c.created_at
                             FROM finance.financial_entries c WHERE c.parent_entry_id IS NOT NULL`,
      security_deposits: `SELECT e.id, e.group_id, e.company_id, e.contract_id, e.third_party_holder_person_id AS holder_person_id,
                                 e.third_party_origin_entry_id AS origin_entry_id, e.third_party_release_type AS release_type,
                                 e.nature, e.amount, e.status, e.settled_at, e.created_at
                            FROM finance.financial_entries e WHERE e.is_third_party_funds = true`,
      accounts_chart: 'SELECT * FROM finance.chart_of_accounts',
      closing_periods: 'SELECT * FROM finance.period_closures',
    };
    for (const [name, sql] of Object.entries(views)) {
      await q(`CREATE OR REPLACE VIEW finance.${name} WITH (security_invoker = true) AS ${sql}`);
      await q(`DROP TRIGGER IF EXISTS ${name}_read_only ON finance.${name}`);
      await q(`CREATE TRIGGER ${name}_read_only INSTEAD OF INSERT OR UPDATE OR DELETE ON finance.${name}
                 FOR EACH ROW EXECUTE FUNCTION finance.caderno_view_read_only()`);
      await q(`COMMENT ON VIEW finance.${name} IS 'Caderno M4 §5 — view somente leitura (security_invoker) sobre o modelo físico.'`);
    }
    const [[{ exists: runtimeExists }]] = await queryInterface.sequelize.query(
      "SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nayara_runtime') AS exists;"
    );
    if (runtimeExists) {
      await q('GRANT SELECT ON finance.ledger, finance.entry_installments, finance.security_deposits, finance.accounts_chart, finance.closing_periods TO nayara_runtime');
    }
  },

  async down(queryInterface) {
    const q = (sql) => queryInterface.sequelize.query(sql);
    for (const name of ['ledger', 'entry_installments', 'security_deposits', 'accounts_chart', 'closing_periods']) {
      await q(`DROP VIEW IF EXISTS finance.${name}`);
    }
    await q('DROP FUNCTION IF EXISTS finance.caderno_view_read_only()');
    await q('ALTER TABLE finance.owner_repasses DROP CONSTRAINT IF EXISTS owner_repasses_deduction_reason_chk');
    await q('ALTER TABLE finance.owner_repasses DROP COLUMN IF EXISTS deductions_reason, DROP COLUMN IF EXISTS deductions_document_file_id');
  },
};
