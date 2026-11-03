'use strict';

/**
 * Migration: Marco 8 — fechamentos da auditoria exaustiva (rodada 10), área fiscal/contábil.
 *
 * - invoice_requests: motivo da rejeição, número da tentativa (chave de idempotência estável),
 *   CHECK de status e de valor positivo, unicidade (origem, tentativa).
 * - invoice_events: observação do evento (motivo do cancelamento/rejeição).
 * - accounting_return_imports: hash informado pelo contador (prova), unicidade (batch, arquivo).
 * - fiscal_reconciliations: nota/tipo da resolução e diferença aceita; uma issue ABERTA por item;
 *   CHECK de status.
 * - dimob_batches / accounting_export_batches: CHECK de status, hash e ano imutáveis, batch DIMOB
 *   fechado imutável, sem DELETE para o papel de runtime.
 * - fiscal_obligations: remove a unicidade duplicada.
 * - finance.tax_documents: conteúdo/hash/número da NFS-e imutáveis (gatilho) e GRANT explícito.
 */
module.exports = {
  up: async (queryInterface) => {
    const q = (sql) => queryInterface.sequelize.query(sql);

    // --- invoice_requests ---
    await q(`ALTER TABLE "correspondent"."invoice_requests"
      ADD COLUMN IF NOT EXISTS rejection_reason TEXT,
      ADD COLUMN IF NOT EXISTS attempt_number INTEGER NOT NULL DEFAULT 1`);
    await q(`UPDATE "correspondent"."invoice_requests" r SET attempt_number = x.n
      FROM (SELECT id, ROW_NUMBER() OVER (PARTITION BY company_id, source_type, source_id ORDER BY created_at, id) - 1 AS n
            FROM "correspondent"."invoice_requests") x
      WHERE r.id = x.id`);
    await q(`ALTER TABLE "correspondent"."invoice_requests" ALTER COLUMN attempt_number DROP DEFAULT`);
    await q(`ALTER TABLE "correspondent"."invoice_requests"
      ADD CONSTRAINT invoice_requests_status_check CHECK (status IN ('REQUESTED','SUBMITTED','UNKNOWN','AUTHORIZED','REJECTED','CANCELED')),
      ADD CONSTRAINT invoice_requests_amount_check CHECK (amount > 0)`);
    await q(`CREATE UNIQUE INDEX IF NOT EXISTS invoice_requests_source_attempt_unique
      ON "correspondent"."invoice_requests" (company_id, source_type, source_id, attempt_number)`);

    // --- invoice_events ---
    await q(`ALTER TABLE "correspondent"."invoice_events" ADD COLUMN IF NOT EXISTS note TEXT`);

    // --- accounting_return_imports ---
    await q(`ALTER TABLE "correspondent"."accounting_return_imports" ADD COLUMN IF NOT EXISTS informed_hash VARCHAR(64)`);
    await q(`CREATE UNIQUE INDEX IF NOT EXISTS accounting_return_imports_batch_file_unique
      ON "correspondent"."accounting_return_imports" (batch_id, returned_hash) WHERE returned_hash IS NOT NULL`);

    // --- fiscal_reconciliations ---
    await q(`ALTER TABLE "correspondent"."fiscal_reconciliations"
      ADD COLUMN IF NOT EXISTS resolution_note TEXT,
      ADD COLUMN IF NOT EXISTS resolution_kind VARCHAR(16),
      ADD COLUMN IF NOT EXISTS accepted_difference NUMERIC(14,2)`);
    // Issues abertas repetidas (se existirem) ficam só com a mais recente antes do índice único.
    await q(`UPDATE "correspondent"."fiscal_reconciliations" f SET status = 'RESOLVED', resolved_at = now(), resolution_kind = 'AUTO',
        resolution_note = 'Encerrada na migração: havia outra divergência aberta para o mesmo item.'
      WHERE status = 'OPEN' AND id NOT IN (
        SELECT DISTINCT ON (company_id, reconciliation_type, reference_id) id
        FROM "correspondent"."fiscal_reconciliations" WHERE status = 'OPEN'
        ORDER BY company_id, reconciliation_type, reference_id, detected_at DESC, id)`);
    await q(`ALTER TABLE "correspondent"."fiscal_reconciliations"
      ADD CONSTRAINT fiscal_reconciliations_status_check CHECK (status IN ('OPEN','RESOLVED')),
      ADD CONSTRAINT fiscal_reconciliations_kind_check CHECK (resolution_kind IS NULL OR resolution_kind IN ('AUTO','MANUAL'))`);
    await q(`CREATE UNIQUE INDEX IF NOT EXISTS fiscal_reconciliations_open_unique
      ON "correspondent"."fiscal_reconciliations" (company_id, reconciliation_type, reference_id) WHERE status = 'OPEN'`);

    // --- dimob_batches / accounting_export_batches ---
    await q(`ALTER TABLE "correspondent"."dimob_batches"
      ADD CONSTRAINT dimob_batches_status_check CHECK (status IN ('DRAFT','CLOSED'))`);
    await q(`ALTER TABLE "correspondent"."accounting_export_batches"
      ADD CONSTRAINT accounting_export_batches_status_check CHECK (status IN ('EXPORTED','RETURNED','DIVERGENT'))`);
    await q(`CREATE OR REPLACE FUNCTION "correspondent".protect_dimob_batch() RETURNS trigger AS $$
      BEGIN
        IF OLD.status = 'CLOSED' THEN
          RAISE EXCEPTION 'Batch DIMOB fechado não pode ser alterado: gere uma nova versão.';
        END IF;
        IF NEW.snapshot_hash <> OLD.snapshot_hash OR NEW.reference_year <> OLD.reference_year OR NEW.version <> OLD.version THEN
          RAISE EXCEPTION 'O hash, o ano e a versão de um batch DIMOB não podem ser alterados.';
        END IF;
        RETURN NEW;
      END; $$ LANGUAGE plpgsql`);
    await q(`DROP TRIGGER IF EXISTS dimob_batches_protect ON "correspondent"."dimob_batches"`);
    await q(`CREATE TRIGGER dimob_batches_protect BEFORE UPDATE ON "correspondent"."dimob_batches"
      FOR EACH ROW EXECUTE FUNCTION "correspondent".protect_dimob_batch()`);
    await q(`CREATE OR REPLACE FUNCTION "correspondent".protect_export_batch() RETURNS trigger AS $$
      BEGIN
        IF NEW.batch_hash <> OLD.batch_hash OR NEW.reference_period <> OLD.reference_period THEN
          RAISE EXCEPTION 'O hash e o período de um batch de exportação contábil não podem ser alterados.';
        END IF;
        RETURN NEW;
      END; $$ LANGUAGE plpgsql`);
    await q(`DROP TRIGGER IF EXISTS accounting_export_batches_protect ON "correspondent"."accounting_export_batches"`);
    await q(`CREATE TRIGGER accounting_export_batches_protect BEFORE UPDATE ON "correspondent"."accounting_export_batches"
      FOR EACH ROW EXECUTE FUNCTION "correspondent".protect_export_batch()`);

    // --- fiscal_obligations: a 349 e a 634 criaram o mesmo índice único com nomes diferentes ---
    await q(`DROP INDEX IF EXISTS "correspondent"."fiscal_obligations_unique"`);

    // --- finance.tax_documents: documento fiscal emitido é imutável ---
    await q(`CREATE OR REPLACE FUNCTION "finance".protect_nfse_tax_document() RETURNS trigger AS $$
      BEGIN
        IF TG_OP = 'DELETE' THEN
          IF OLD.invoice_request_id IS NOT NULL THEN
            RAISE EXCEPTION 'Documento fiscal de NFS-e emitida não pode ser apagado.';
          END IF;
          RETURN OLD;
        END IF;
        IF OLD.invoice_request_id IS NOT NULL AND (
          NEW.xml_content IS DISTINCT FROM OLD.xml_content OR NEW.xml_sha256 IS DISTINCT FROM OLD.xml_sha256
          OR NEW.pdf_content IS DISTINCT FROM OLD.pdf_content OR NEW.pdf_sha256 IS DISTINCT FROM OLD.pdf_sha256
          OR NEW.document_number IS DISTINCT FROM OLD.document_number OR NEW.invoice_request_id IS DISTINCT FROM OLD.invoice_request_id
          OR NEW.amount IS DISTINCT FROM OLD.amount OR NEW.verification_code IS DISTINCT FROM OLD.verification_code) THEN
          RAISE EXCEPTION 'XML, PDF, número e valor de uma NFS-e emitida não podem ser alterados.';
        END IF;
        RETURN NEW;
      END; $$ LANGUAGE plpgsql`);
    await q(`DROP TRIGGER IF EXISTS tax_documents_protect_nfse ON "finance"."tax_documents"`);
    await q(`CREATE TRIGGER tax_documents_protect_nfse BEFORE UPDATE OR DELETE ON "finance"."tax_documents"
      FOR EACH ROW EXECUTE FUNCTION "finance".protect_nfse_tax_document()`);

    const [[{ exists: runtimeExists }]] = await queryInterface.sequelize.query("SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nayara_runtime') AS exists;");
    if (runtimeExists) {
      await q(`GRANT SELECT, INSERT, UPDATE, DELETE ON "finance"."tax_documents" TO nayara_runtime`);
      await q(`REVOKE DELETE ON "correspondent"."dimob_batches", "correspondent"."accounting_export_batches", "correspondent"."accounting_return_imports", "correspondent"."invoice_requests" FROM nayara_runtime`);
    }
  },

  down: async (queryInterface) => {
    const q = (sql) => queryInterface.sequelize.query(sql);
    const [[{ exists: runtimeExists }]] = await queryInterface.sequelize.query("SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nayara_runtime') AS exists;");
    if (runtimeExists) {
      await q(`GRANT DELETE ON "correspondent"."dimob_batches", "correspondent"."accounting_export_batches", "correspondent"."accounting_return_imports", "correspondent"."invoice_requests" TO nayara_runtime`);
    }
    await q(`DROP TRIGGER IF EXISTS tax_documents_protect_nfse ON "finance"."tax_documents"`);
    await q(`DROP FUNCTION IF EXISTS "finance".protect_nfse_tax_document()`);
    await q(`CREATE UNIQUE INDEX IF NOT EXISTS fiscal_obligations_unique ON "correspondent"."fiscal_obligations" (company_id, obligation_type, reference_year)`);
    await q(`DROP TRIGGER IF EXISTS accounting_export_batches_protect ON "correspondent"."accounting_export_batches"`);
    await q(`DROP FUNCTION IF EXISTS "correspondent".protect_export_batch()`);
    await q(`DROP TRIGGER IF EXISTS dimob_batches_protect ON "correspondent"."dimob_batches"`);
    await q(`DROP FUNCTION IF EXISTS "correspondent".protect_dimob_batch()`);
    await q(`ALTER TABLE "correspondent"."accounting_export_batches" DROP CONSTRAINT IF EXISTS accounting_export_batches_status_check`);
    await q(`ALTER TABLE "correspondent"."dimob_batches" DROP CONSTRAINT IF EXISTS dimob_batches_status_check`);
    await q(`DROP INDEX IF EXISTS "correspondent"."fiscal_reconciliations_open_unique"`);
    await q(`ALTER TABLE "correspondent"."fiscal_reconciliations" DROP CONSTRAINT IF EXISTS fiscal_reconciliations_kind_check, DROP CONSTRAINT IF EXISTS fiscal_reconciliations_status_check`);
    await q(`ALTER TABLE "correspondent"."fiscal_reconciliations" DROP COLUMN IF EXISTS accepted_difference, DROP COLUMN IF EXISTS resolution_kind, DROP COLUMN IF EXISTS resolution_note`);
    await q(`DROP INDEX IF EXISTS "correspondent"."accounting_return_imports_batch_file_unique"`);
    await q(`ALTER TABLE "correspondent"."accounting_return_imports" DROP COLUMN IF EXISTS informed_hash`);
    await q(`ALTER TABLE "correspondent"."invoice_events" DROP COLUMN IF EXISTS note`);
    await q(`DROP INDEX IF EXISTS "correspondent"."invoice_requests_source_attempt_unique"`);
    await q(`ALTER TABLE "correspondent"."invoice_requests" DROP CONSTRAINT IF EXISTS invoice_requests_amount_check, DROP CONSTRAINT IF EXISTS invoice_requests_status_check`);
    await q(`ALTER TABLE "correspondent"."invoice_requests" DROP COLUMN IF EXISTS attempt_number, DROP COLUMN IF EXISTS rejection_reason`);
  },
};
