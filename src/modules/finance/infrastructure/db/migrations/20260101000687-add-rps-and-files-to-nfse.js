'use strict';

/**
 * Marco 9, M9-D241 — NFS-e sobre o registro de integração.
 *  - correspondent.nfse_rps_sequences: o contador do RPS por empresa e série (número único e crescente; a correção de uma nota recusada pega outro número). RLS ENABLE + FORCE.
 *  - correspondent.invoice_requests: rps_series, rps_number (único por empresa e série), issuer_key (a chave de idempotência do envio, derivada do RPS) e dispatch_id (o envio da emissão).
 *  - finance.tax_documents: xml_file_id e pdf_file_id (o XML e o PDF oficiais guardados em people.files, com o hash na linha do arquivo).
 */
module.exports = {
  up: async (queryInterface) => {
    const q = (sql) => queryInterface.sequelize.query(sql);
    await q(`
      CREATE TABLE IF NOT EXISTS "correspondent"."nfse_rps_sequences" (
        group_id uuid NOT NULL REFERENCES "core"."groups"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
        company_id uuid NOT NULL REFERENCES "core"."companies"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
        series varchar(8) NOT NULL,
        last_number bigint NOT NULL DEFAULT 0 CHECK (last_number >= 0),
        updated_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (company_id, series)
      );
    `);
    await q('ALTER TABLE "correspondent"."nfse_rps_sequences" ENABLE ROW LEVEL SECURITY;');
    await q(`CREATE POLICY tenant_isolation ON "correspondent"."nfse_rps_sequences"
      USING (company_id = NULLIF(current_setting('app.company_id', true), '')::uuid)
      WITH CHECK (company_id = NULLIF(current_setting('app.company_id', true), '')::uuid);`);
    await q('ALTER TABLE "correspondent"."nfse_rps_sequences" FORCE ROW LEVEL SECURITY;');

    await q('ALTER TABLE "correspondent"."invoice_requests" ADD COLUMN IF NOT EXISTS rps_series varchar(8);');
    await q('ALTER TABLE "correspondent"."invoice_requests" ADD COLUMN IF NOT EXISTS rps_number bigint;');
    await q('ALTER TABLE "correspondent"."invoice_requests" ADD COLUMN IF NOT EXISTS issuer_key varchar(160);');
    await q('ALTER TABLE "correspondent"."invoice_requests" ADD COLUMN IF NOT EXISTS dispatch_id uuid;');
    await q('CREATE UNIQUE INDEX IF NOT EXISTS invoice_requests_rps_unique ON "correspondent"."invoice_requests" (company_id, rps_series, rps_number) WHERE rps_number IS NOT NULL;');
    await q('CREATE INDEX IF NOT EXISTS invoice_requests_dispatch_idx ON "correspondent"."invoice_requests" (company_id, dispatch_id) WHERE dispatch_id IS NOT NULL;');

    await q('ALTER TABLE "finance"."tax_documents" ADD COLUMN IF NOT EXISTS xml_file_id uuid REFERENCES "people"."files"(id) ON DELETE RESTRICT ON UPDATE CASCADE;');
    await q('ALTER TABLE "finance"."tax_documents" ADD COLUMN IF NOT EXISTS pdf_file_id uuid REFERENCES "people"."files"(id) ON DELETE RESTRICT ON UPDATE CASCADE;');
    await q('CREATE INDEX IF NOT EXISTS tax_documents_xml_file_idx ON "finance"."tax_documents" (xml_file_id) WHERE xml_file_id IS NOT NULL;');
    await q('CREATE INDEX IF NOT EXISTS tax_documents_pdf_file_idx ON "finance"."tax_documents" (pdf_file_id) WHERE pdf_file_id IS NOT NULL;');

    await q(`DO $g$ BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nayara_runtime') THEN
        GRANT USAGE ON SCHEMA "correspondent" TO nayara_runtime;
        GRANT SELECT, INSERT, UPDATE ON "correspondent"."nfse_rps_sequences" TO nayara_runtime;
      END IF;
    END $g$;`);
  },

  down: async (queryInterface) => {
    const q = (sql) => queryInterface.sequelize.query(sql);
    await q('ALTER TABLE "finance"."tax_documents" DROP COLUMN IF EXISTS pdf_file_id;');
    await q('ALTER TABLE "finance"."tax_documents" DROP COLUMN IF EXISTS xml_file_id;');
    await q('DROP INDEX IF EXISTS "correspondent".invoice_requests_dispatch_idx;');
    await q('DROP INDEX IF EXISTS "correspondent".invoice_requests_rps_unique;');
    await q('ALTER TABLE "correspondent"."invoice_requests" DROP COLUMN IF EXISTS dispatch_id;');
    await q('ALTER TABLE "correspondent"."invoice_requests" DROP COLUMN IF EXISTS issuer_key;');
    await q('ALTER TABLE "correspondent"."invoice_requests" DROP COLUMN IF EXISTS rps_number;');
    await q('ALTER TABLE "correspondent"."invoice_requests" DROP COLUMN IF EXISTS rps_series;');
    await q('DROP TABLE IF EXISTS "correspondent"."nfse_rps_sequences";');
  },
};
