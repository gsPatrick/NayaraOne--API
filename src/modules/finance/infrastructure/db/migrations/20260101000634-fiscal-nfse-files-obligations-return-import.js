'use strict';

/**
 * Marco 8 — fiscal: XML/PDF/ID oficial da NFS-e preservados, calendário de obrigações com
 * unicidade por empresa/tipo/ano e importação do retorno contábil com validação de hash.
 */
module.exports = {
  up: async (queryInterface) => {
    const q = (sql) => queryInterface.sequelize.query(sql);

    await q(`ALTER TABLE "finance"."tax_documents"
      ADD COLUMN IF NOT EXISTS xml_content TEXT,
      ADD COLUMN IF NOT EXISTS xml_sha256 VARCHAR(64),
      ADD COLUMN IF NOT EXISTS pdf_content BYTEA,
      ADD COLUMN IF NOT EXISTS pdf_sha256 VARCHAR(64),
      ADD COLUMN IF NOT EXISTS verification_code VARCHAR(64)`);

    await q(`ALTER TABLE "correspondent"."fiscal_obligations"
      ADD COLUMN IF NOT EXISTS description TEXT,
      ADD COLUMN IF NOT EXISTS dimob_batch_id UUID`);
    await q(`UPDATE "correspondent"."fiscal_obligations" SET description = 'Obrigação fiscal ' || obligation_type || ' ' || reference_year WHERE description IS NULL`);
    await q(`ALTER TABLE "correspondent"."fiscal_obligations" ALTER COLUMN description SET NOT NULL`);
    await q(`ALTER TABLE "correspondent"."fiscal_obligations"
      ADD CONSTRAINT fiscal_obligations_status_check CHECK (status IN ('PENDING','COMPLETED','OVERDUE'))`);
    await q(`CREATE UNIQUE INDEX IF NOT EXISTS fiscal_obligations_company_type_year_unique
      ON "correspondent"."fiscal_obligations" (company_id, obligation_type, reference_year)`);

    await q(`ALTER TABLE "correspondent"."accounting_return_imports"
      ADD COLUMN IF NOT EXISTS batch_id UUID REFERENCES "correspondent"."accounting_export_batches"(id) ON DELETE CASCADE,
      ADD COLUMN IF NOT EXISTS expected_hash VARCHAR(64),
      ADD COLUMN IF NOT EXISTS returned_hash VARCHAR(64),
      ADD COLUMN IF NOT EXISTS status VARCHAR(16) NOT NULL DEFAULT 'MATCHED',
      ADD COLUMN IF NOT EXISTS line_count INTEGER NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS expected_total NUMERIC(14,2) NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS returned_total NUMERIC(14,2) NOT NULL DEFAULT 0`);
    await q(`ALTER TABLE "correspondent"."accounting_return_imports"
      ADD CONSTRAINT accounting_return_imports_status_check CHECK (status IN ('MATCHED','DIVERGENT'))`);
    await q(`CREATE INDEX IF NOT EXISTS accounting_return_imports_batch_idx ON "correspondent"."accounting_return_imports" (batch_id)`);
  },

  down: async (queryInterface) => {
    const q = (sql) => queryInterface.sequelize.query(sql);
    await q(`ALTER TABLE "correspondent"."accounting_return_imports" DROP CONSTRAINT IF EXISTS accounting_return_imports_status_check`);
    await q(`ALTER TABLE "correspondent"."accounting_return_imports" DROP COLUMN IF EXISTS returned_total, DROP COLUMN IF EXISTS expected_total, DROP COLUMN IF EXISTS line_count, DROP COLUMN IF EXISTS status, DROP COLUMN IF EXISTS returned_hash, DROP COLUMN IF EXISTS expected_hash, DROP COLUMN IF EXISTS batch_id`);
    await q(`DROP INDEX IF EXISTS "correspondent"."fiscal_obligations_company_type_year_unique"`);
    await q(`ALTER TABLE "correspondent"."fiscal_obligations" DROP CONSTRAINT IF EXISTS fiscal_obligations_status_check`);
    await q(`ALTER TABLE "correspondent"."fiscal_obligations" DROP COLUMN IF EXISTS dimob_batch_id, DROP COLUMN IF EXISTS description`);
    await q(`ALTER TABLE "finance"."tax_documents" DROP COLUMN IF EXISTS verification_code, DROP COLUMN IF EXISTS pdf_sha256, DROP COLUMN IF EXISTS pdf_content, DROP COLUMN IF EXISTS xml_sha256, DROP COLUMN IF EXISTS xml_content`);
  },
};
