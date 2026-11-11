'use strict';

/**
 * Fechamento M5 — Obrigações da locação com o nome e os dados do livro (Caderno M5 §4 "legal.lease_obligations",
 * §12 "Cada obrigação possui responsável, periodicidade, comprovante e status"; M5-D102/M5-D350/M5-D103):
 *  - finance.utility_obligations vira legal.lease_obligations (ALTER TABLE SET SCHEMA + RENAME: linhas, chaves,
 *    índices, FKs, RLS ENABLE+FORCE, policy e GRANTs seguem a tabela, ligados pelo OID);
 *  - periodicidade (periodicity, due_day), início (starts_on, gravado quando as chaves são entregues) e próximo
 *    vencimento (next_due_on);
 *  - ownership_transfer_tasks.due_date: prazo da troca de titularidade (contado da entrega das chaves);
 *  - o nome do bloco de cobrança (finance.utility_obligations) continua resolvendo por uma VISÃO simples e gravável
 *    (security_invoker: o RLS da tabela vale para quem consulta), com os mesmos privilégios do runtime.
 * Idempotente (to_regclass) e reversível.
 */
const PERIODICITIES = "'MONTHLY','BIMONTHLY','QUARTERLY','SEMIANNUAL','ANNUAL','ONE_TIME'";

module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql) => sequelize.query(sql, { transaction });
      await q(`DO $$ BEGIN
        IF to_regclass('legal.lease_obligations') IS NULL
           AND (SELECT relkind FROM pg_class WHERE oid = to_regclass('finance.utility_obligations')) = 'r' THEN
          ALTER TABLE finance.utility_obligations SET SCHEMA legal;
          ALTER TABLE legal.utility_obligations RENAME TO lease_obligations;
        END IF;
      END $$`);
      await q(`ALTER TABLE legal.lease_obligations
        ADD COLUMN IF NOT EXISTS periodicity varchar(16) NULL,
        ADD COLUMN IF NOT EXISTS due_day smallint NULL,
        ADD COLUMN IF NOT EXISTS starts_on date NULL,
        ADD COLUMN IF NOT EXISTS next_due_on date NULL`);
      await q(`DO $c$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lease_obligations_periodicity_chk') THEN
          ALTER TABLE legal.lease_obligations ADD CONSTRAINT lease_obligations_periodicity_chk
            CHECK (periodicity IS NULL OR periodicity IN (${PERIODICITIES})) NOT VALID;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lease_obligations_due_day_chk') THEN
          ALTER TABLE legal.lease_obligations ADD CONSTRAINT lease_obligations_due_day_chk CHECK (due_day IS NULL OR due_day BETWEEN 1 AND 31) NOT VALID;
        END IF;
      END $c$`);
      // Legado sem periodicidade: IPTU e SPU são anuais por lei; as contas de consumo e o condomínio, mensais.
      await q(`UPDATE legal.lease_obligations SET periodicity = CASE WHEN utility_type IN ('IPTU','SPU') THEN 'ANNUAL' ELSE 'MONTHLY' END WHERE periodicity IS NULL`);
      await q('ALTER TABLE finance.ownership_transfer_tasks ADD COLUMN IF NOT EXISTS due_date date NULL');

      await q(`DO $$ BEGIN
        IF to_regclass('finance.utility_obligations') IS NULL THEN
          CREATE VIEW finance.utility_obligations WITH (security_invoker = true) AS SELECT * FROM legal.lease_obligations;
        END IF;
      END $$`);
      await q(`COMMENT ON VIEW finance.utility_obligations IS 'Nome do bloco de cobrança do caderno do Marco 5 para legal.lease_obligations (mesma linha, sem cópia).'`);
      await q(`DO $$ BEGIN
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nayara_runtime') THEN
          GRANT USAGE ON SCHEMA legal TO nayara_runtime;
          IF has_table_privilege('nayara_runtime', 'legal.lease_obligations', 'SELECT') THEN GRANT SELECT ON finance.utility_obligations TO nayara_runtime; END IF;
          IF has_table_privilege('nayara_runtime', 'legal.lease_obligations', 'INSERT') THEN GRANT INSERT ON finance.utility_obligations TO nayara_runtime; END IF;
          IF has_table_privilege('nayara_runtime', 'legal.lease_obligations', 'UPDATE') THEN GRANT UPDATE ON finance.utility_obligations TO nayara_runtime; END IF;
          IF has_table_privilege('nayara_runtime', 'legal.lease_obligations', 'DELETE') THEN GRANT DELETE ON finance.utility_obligations TO nayara_runtime; END IF;
        END IF;
      END $$`);
    });
  },

  async down(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql) => sequelize.query(sql, { transaction });
      await q(`DO $$ BEGIN
        IF (SELECT relkind FROM pg_class WHERE oid = to_regclass('finance.utility_obligations')) = 'v' THEN
          DROP VIEW finance.utility_obligations;
        END IF;
      END $$`);
      await q('ALTER TABLE finance.ownership_transfer_tasks DROP COLUMN IF EXISTS due_date');
      await q(`ALTER TABLE legal.lease_obligations DROP CONSTRAINT IF EXISTS lease_obligations_periodicity_chk, DROP CONSTRAINT IF EXISTS lease_obligations_due_day_chk,
        DROP COLUMN IF EXISTS periodicity, DROP COLUMN IF EXISTS due_day, DROP COLUMN IF EXISTS starts_on, DROP COLUMN IF EXISTS next_due_on`);
      await q(`DO $$ BEGIN
        IF to_regclass('legal.lease_obligations') IS NOT NULL AND to_regclass('finance.utility_obligations') IS NULL THEN
          ALTER TABLE legal.lease_obligations RENAME TO utility_obligations;
          ALTER TABLE legal.utility_obligations SET SCHEMA finance;
        END IF;
      END $$`);
    });
  },
};
