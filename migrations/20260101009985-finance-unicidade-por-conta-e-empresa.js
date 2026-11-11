'use strict';

/**
 * Guia M4 §10 "Importação bancária idempotente" — UNIQUE(bank_account_id, fingerprint) — e
 * isolamento entre empresas (fechamento do Marco 4, 10/11/2026).
 *
 * Defeito: external_transaction_id era UNIQUE GLOBAL. A empresa B, importando o extrato da
 * PRÓPRIA conta com um id externo que por acaso já existia numa linha da empresa A, recebia 409
 * UNIQUE_CONSTRAINT_VIOLATION — vazava a existência do dado de outra empresa e bloqueava uma
 * importação legítima. A unicidade passa a valer por conta:
 *   - UNIQUE (bank_account_id, external_transaction_id) — reimportar na mesma conta continua
 *     deduplicando (a aplicação devolve "duplicada", nenhuma linha nova);
 *   - coluna fingerprint (sha256 do Guia §10, bankTransactionFingerprint.js) com
 *     UNIQUE (bank_account_id, fingerprint) para as linhas com id externo (sem id do provedor,
 *     duas linhas iguais no mesmo dia podem ser legítimas e não são barradas pelo banco).
 * As linhas já gravadas recebem o fingerprint calculado aqui com a mesma fórmula.
 *
 * Mesmo defeito, mesma correção, em finance.financial_entries.idempotency_key e
 * finance.owner_repasses.idempotency_key (UNIQUE GLOBAL sobre chave informada pelo cliente):
 * passam a ser únicas por EMPRESA — UNIQUE (company_id, idempotency_key).
 * Conferidas as outras unicidades do schema finance: as demais já são por empresa/conta ou sobre
 * identificadores gerados pelo sistema (uuid de contrato, lançamento, arquivo, conexão, pedido)
 * que não colidem entre empresas; bank_payment_provider_routing.external_submission_id é global
 * por desenho (roteamento do webhook público do banco, sem RLS).
 */
const fingerprintSql = (p) => `encode(sha256(convert_to(concat_ws('|',
      ${p}bank_account_id::text,
      COALESCE(${p}external_transaction_id, ''),
      to_char(${p}transaction_date AT TIME ZONE 'America/Sao_Paulo', 'YYYY-MM-DD'),
      to_char(abs(${p}amount), 'FM9999999999999999990.00'),
      CASE WHEN ${p}amount < 0 THEN 'DEBIT' ELSE 'CREDIT' END,
      lower(regexp_replace(btrim(COALESCE(${p}description, '')), '\\s+', ' ', 'g'))
    ), 'UTF8')), 'hex')`;
const FINGERPRINT_SQL = fingerprintSql('');

async function runtimeRoleExists(queryInterface) {
  const [[{ exists }]] = await queryInterface.sequelize.query("SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nayara_runtime') AS exists;");
  return exists;
}

async function singleColumnUniques(queryInterface, table, column) {
  const [rows] = await queryInterface.sequelize.query(`
    SELECT c.conname
      FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
     WHERE n.nspname = 'finance' AND t.relname = :table AND c.contype = 'u'
       AND array_length(c.conkey, 1) = 1
       AND c.conkey[1] = (SELECT attnum FROM pg_attribute WHERE attrelid = t.oid AND attname = :column)`, { replacements: { table, column } });
  return rows.map((r) => r.conname);
}

async function globalExternalIdConstraints(queryInterface) {
  const [rows] = await queryInterface.sequelize.query(`
    SELECT c.conname
      FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
     WHERE n.nspname = 'finance' AND t.relname = 'bank_transactions' AND c.contype = 'u'
       AND array_length(c.conkey, 1) = 1
       AND c.conkey[1] = (SELECT attnum FROM pg_attribute WHERE attrelid = t.oid AND attname = 'external_transaction_id')`);
  return rows.map((r) => r.conname);
}

module.exports = {
  async up(queryInterface) {
    const q = (sql) => queryInterface.sequelize.query(sql);
    for (const name of await globalExternalIdConstraints(queryInterface)) {
      await q(`ALTER TABLE finance.bank_transactions DROP CONSTRAINT "${name}"`);
    }
    await q('ALTER TABLE finance.bank_transactions ADD COLUMN IF NOT EXISTS fingerprint varchar(64) NULL');
    await q(`UPDATE finance.bank_transactions SET fingerprint = ${FINGERPRINT_SQL} WHERE fingerprint IS NULL`);
    await q('ALTER TABLE finance.bank_transactions ALTER COLUMN fingerprint SET NOT NULL');
    // Toda linha ganha o fingerprint também quando é gravada por SQL direto (carga, ferramentas,
    // provedor): o gatilho calcula com a mesma fórmula quando a aplicação não informou.
    await q(`CREATE OR REPLACE FUNCTION finance.bank_transactions_fill_fingerprint() RETURNS trigger LANGUAGE plpgsql AS $f$
             BEGIN
               IF NEW.fingerprint IS NULL THEN
                 NEW.fingerprint := ${fingerprintSql('NEW.')};
               END IF;
               RETURN NEW;
             END $f$`);
    await q('DROP TRIGGER IF EXISTS bank_transactions_fill_fingerprint ON finance.bank_transactions');
    await q(`CREATE TRIGGER bank_transactions_fill_fingerprint BEFORE INSERT ON finance.bank_transactions
               FOR EACH ROW EXECUTE FUNCTION finance.bank_transactions_fill_fingerprint()`);
    // ALWAYS: vale também em carga com session_replication_role = replica (o valor é dado, não regra de negócio).
    await q('ALTER TABLE finance.bank_transactions ENABLE ALWAYS TRIGGER bank_transactions_fill_fingerprint');
    await q(`CREATE UNIQUE INDEX IF NOT EXISTS bank_transactions_account_external_id_uk
               ON finance.bank_transactions (bank_account_id, external_transaction_id) WHERE external_transaction_id IS NOT NULL`);
    await q(`CREATE UNIQUE INDEX IF NOT EXISTS bank_transactions_account_fingerprint_uk
               ON finance.bank_transactions (bank_account_id, fingerprint) WHERE external_transaction_id IS NOT NULL`);
    for (const name of await singleColumnUniques(queryInterface, 'financial_entries', 'idempotency_key')) {
      await q(`ALTER TABLE finance.financial_entries DROP CONSTRAINT "${name}"`);
    }
    await q(`CREATE UNIQUE INDEX IF NOT EXISTS financial_entries_company_idempotency_uk
               ON finance.financial_entries (company_id, idempotency_key) WHERE idempotency_key IS NOT NULL`);
    for (const name of await singleColumnUniques(queryInterface, 'owner_repasses', 'idempotency_key')) {
      await q(`ALTER TABLE finance.owner_repasses DROP CONSTRAINT "${name}"`);
    }
    await q(`CREATE UNIQUE INDEX IF NOT EXISTS owner_repasses_company_idempotency_uk
               ON finance.owner_repasses (company_id, idempotency_key) WHERE idempotency_key IS NOT NULL`);
    if (await runtimeRoleExists(queryInterface)) {
      await q('GRANT SELECT, INSERT ON finance.bank_transactions TO nayara_runtime');
      await q('GRANT SELECT, INSERT ON finance.financial_entries TO nayara_runtime');
      await q('GRANT SELECT, INSERT ON finance.owner_repasses TO nayara_runtime');
    }
  },

  async down(queryInterface) {
    const q = (sql) => queryInterface.sequelize.query(sql);
    await q('DROP INDEX IF EXISTS finance.owner_repasses_company_idempotency_uk');
    await q('ALTER TABLE finance.owner_repasses ADD CONSTRAINT owner_repasses_idempotency_key_key UNIQUE (idempotency_key)');
    await q('DROP INDEX IF EXISTS finance.financial_entries_company_idempotency_uk');
    await q('ALTER TABLE finance.financial_entries ADD CONSTRAINT financial_entries_idempotency_key_key UNIQUE (idempotency_key)');
    await q('DROP INDEX IF EXISTS finance.bank_transactions_account_fingerprint_uk');
    await q('DROP INDEX IF EXISTS finance.bank_transactions_account_external_id_uk');
    await q('DROP TRIGGER IF EXISTS bank_transactions_fill_fingerprint ON finance.bank_transactions');
    await q('DROP FUNCTION IF EXISTS finance.bank_transactions_fill_fingerprint()');
    await q('ALTER TABLE finance.bank_transactions DROP COLUMN IF EXISTS fingerprint');
    // Volta a unicidade global antiga (falha se já houver o mesmo id externo em contas diferentes — é o dado que a correção passou a aceitar).
    await q('ALTER TABLE finance.bank_transactions ADD CONSTRAINT bank_transactions_external_transaction_id_key UNIQUE (external_transaction_id)');
  },
};
