'use strict';

/**
 * M9-D414 — marketing.automation_action_receipts: o recibo de cada ação de automação cujo destino não guarda a `action_key` (aviso ao usuário, rascunho de conteúdo,
 * pedido de avaliação, ocorrência e etapa/etiqueta do CRM). Tarefa e mensagem já guardam a chave na própria coluna (M9-D415). O UNIQUE (empresa, action_key) faz o
 * papel do Idempotency-Key: repetir a ação com a mesma chave não executa o destino outra vez, mesmo que o resultado da run não tenha sido gravado.
 *
 * RLS FORCE por grupo e empresa (fail-closed); GRANT ao nayara_runtime só se o role existir (SELECT, INSERT, UPDATE: a referência do destino é gravada depois do recibo).
 * FK para a run (a RLS por empresa vale nas duas tabelas). Idempotente, numa transação. O down recusa se houver dado.
 */
module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql) => sequelize.query(sql, { transaction });
      await q(`CREATE TABLE IF NOT EXISTS marketing.automation_action_receipts (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        group_id uuid NOT NULL REFERENCES core.groups(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        company_id uuid NOT NULL REFERENCES core.companies(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        run_id uuid NOT NULL,
        action_key char(64) NOT NULL,
        action_type varchar(32) NOT NULL,
        destination_ref varchar(200) NULL,
        created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT mkt_action_receipts_key_uq UNIQUE (company_id, action_key),
        CONSTRAINT mkt_action_receipts_key_chk CHECK (action_key ~ '^[0-9a-f]{64}$'),
        CONSTRAINT mkt_action_receipts_type_chk CHECK (action_type IN ('NOTIFY_USER','CREATE_CONTENT_DRAFT','REQUEST_REVIEW','OPEN_CASE','UPDATE_CRM_STAGE_TAG')),
        CONSTRAINT mkt_action_receipts_run_fk FOREIGN KEY (run_id) REFERENCES marketing.automation_runs (id) ON UPDATE CASCADE ON DELETE RESTRICT
      )`);
      await q('CREATE INDEX IF NOT EXISTS mkt_action_receipts_run_idx ON marketing.automation_action_receipts (company_id, run_id)');
      await q('CREATE INDEX IF NOT EXISTS mkt_action_receipts_group_idx ON marketing.automation_action_receipts (group_id)');
      await q('ALTER TABLE marketing.automation_action_receipts ENABLE ROW LEVEL SECURITY');
      await q('ALTER TABLE marketing.automation_action_receipts FORCE ROW LEVEL SECURITY');
      await q('DROP POLICY IF EXISTS tenant_isolation ON marketing.automation_action_receipts');
      await q(`CREATE POLICY tenant_isolation ON marketing.automation_action_receipts
        USING (group_id = NULLIF(current_setting('app.group_id', true), '')::uuid
               AND company_id = NULLIF(current_setting('app.company_id', true), '')::uuid)`);
      const [[{ exists }]] = await sequelize.query("SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nayara_runtime') AS exists", { transaction });
      if (exists) {
        await q('GRANT USAGE ON SCHEMA marketing TO nayara_runtime');
        await q('GRANT SELECT, INSERT, UPDATE ON marketing.automation_action_receipts TO nayara_runtime');
      }
    });
  },

  async down(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const [[{ reg }]] = await sequelize.query("SELECT to_regclass('marketing.automation_action_receipts') AS reg", { transaction });
      if (reg) {
        const [[{ n }]] = await sequelize.query('SELECT count(*)::int AS n FROM marketing.automation_action_receipts', { transaction });
        if (n > 0) throw new Error(`MKT_MIGRATION_DOWN_NOT_EMPTY: ${n} recibo(s) em marketing.automation_action_receipts; o histórico das ações não é apagado.`);
      }
      await sequelize.query('DROP TABLE IF EXISTS marketing.automation_action_receipts', { transaction });
    });
  },
};
