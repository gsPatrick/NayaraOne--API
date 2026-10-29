'use strict';

/**
 * Marco 9, M9-D236 — envelope de assinatura e evidência por assinatura.
 *  - legal.signature_envelopes: o envelope pedido ao fornecedor (SignatureAdapter.createEnvelope) para UMA versão aprovada do contrato: o hash SHA-256 enviado, o par
 *    (connection_id, external_envelope_id) que o fornecedor devolveu (único), o estado (PENDING, SIGNED, CANCELLED, HASH_MISMATCH), o hash do arquivo assinado e o do
 *    conteúdo original que o fornecedor confirmou. RLS ENABLE + FORCE.
 *  - legal.signatures: envelope_id, e-mail previsto do signatário, evidence_json (horário do fornecedor, IP, user-agent, método de autenticação, hash do documento,
 *    identificador do evento) e evidence_complete. A evidência é imutável: depois de gravada, nenhum UPDATE a altera (gatilho).
 */
const ESTADOS = ['PENDING', 'SIGNED', 'CANCELLED', 'HASH_MISMATCH'];

module.exports = {
  up: async (queryInterface) => {
    const q = (sql) => queryInterface.sequelize.query(sql);
    await q(`
      CREATE TABLE IF NOT EXISTS "legal"."signature_envelopes" (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        group_id uuid NOT NULL REFERENCES "core"."groups"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
        company_id uuid NOT NULL REFERENCES "core"."companies"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
        contract_version_id uuid NOT NULL REFERENCES "legal"."contract_versions"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
        connection_id uuid REFERENCES "integration"."connections"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
        provider_code varchar(48) NOT NULL,
        external_envelope_id varchar(160),
        document_sha256 char(64) NOT NULL,
        status varchar(16) NOT NULL DEFAULT 'PENDING' CHECK (status IN (${ESTADOS.map((e) => `'${e}'`).join(', ')})),
        signed_sha256 char(64),
        original_confirmed_sha256 char(64),
        signed_document_file_id uuid,
        dispatch_id uuid,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
    `);
    await q('CREATE UNIQUE INDEX IF NOT EXISTS signature_envelopes_provider_id_uidx ON "legal"."signature_envelopes" (connection_id, external_envelope_id) WHERE external_envelope_id IS NOT NULL;');
    await q('CREATE INDEX IF NOT EXISTS signature_envelopes_version_idx ON "legal"."signature_envelopes" (company_id, contract_version_id);');
    await q('CREATE INDEX IF NOT EXISTS signature_envelopes_dispatch_idx ON "legal"."signature_envelopes" (company_id, dispatch_id) WHERE dispatch_id IS NOT NULL;');
    await q('ALTER TABLE "legal"."signature_envelopes" ENABLE ROW LEVEL SECURITY;');
    await q(`DO $p$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polname = 'tenant_isolation' AND polrelid = '"legal"."signature_envelopes"'::regclass) THEN
        CREATE POLICY tenant_isolation ON "legal"."signature_envelopes"
          USING (company_id = NULLIF(current_setting('app.company_id', true), '')::uuid)
          WITH CHECK (company_id = NULLIF(current_setting('app.company_id', true), '')::uuid);
      END IF;
    END $p$;`);
    await q('ALTER TABLE "legal"."signature_envelopes" FORCE ROW LEVEL SECURITY;');

    await q('ALTER TABLE "legal"."signatures" ADD COLUMN IF NOT EXISTS envelope_id uuid REFERENCES "legal"."signature_envelopes"(id) ON DELETE RESTRICT ON UPDATE CASCADE;');
    await q('ALTER TABLE "legal"."signatures" ADD COLUMN IF NOT EXISTS signer_email varchar(254);');
    await q('ALTER TABLE "legal"."signatures" ADD COLUMN IF NOT EXISTS evidence_json jsonb;');
    await q('ALTER TABLE "legal"."signatures" ADD COLUMN IF NOT EXISTS evidence_complete boolean NOT NULL DEFAULT false;');
    await q('CREATE INDEX IF NOT EXISTS signatures_envelope_idx ON "legal"."signatures" (envelope_id) WHERE envelope_id IS NOT NULL;');
    await q(`
      CREATE OR REPLACE FUNCTION "legal".signatures_evidence_immutable() RETURNS trigger LANGUAGE plpgsql AS $f$
      BEGIN
        IF OLD.evidence_json IS NOT NULL AND NEW.evidence_json IS DISTINCT FROM OLD.evidence_json THEN
          RAISE EXCEPTION 'A evidência da assinatura é imutável' USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
      END
      $f$;
    `);
    await q('DROP TRIGGER IF EXISTS signatures_evidence_immutable_trg ON "legal"."signatures";');
    await q('CREATE TRIGGER signatures_evidence_immutable_trg BEFORE UPDATE ON "legal"."signatures" FOR EACH ROW EXECUTE FUNCTION "legal".signatures_evidence_immutable();');

    await q(`DO $g$ BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nayara_runtime') THEN
        GRANT SELECT, INSERT, UPDATE ON "legal"."signature_envelopes" TO nayara_runtime;
      END IF;
    END $g$;`);
  },

  down: async (queryInterface) => {
    const q = (sql) => queryInterface.sequelize.query(sql);
    await q('DROP TRIGGER IF EXISTS signatures_evidence_immutable_trg ON "legal"."signatures";');
    await q('DROP FUNCTION IF EXISTS "legal".signatures_evidence_immutable();');
    await q('DROP INDEX IF EXISTS "legal".signatures_envelope_idx;');
    await q('ALTER TABLE "legal"."signatures" DROP COLUMN IF EXISTS evidence_complete;');
    await q('ALTER TABLE "legal"."signatures" DROP COLUMN IF EXISTS evidence_json;');
    await q('ALTER TABLE "legal"."signatures" DROP COLUMN IF EXISTS signer_email;');
    await q('ALTER TABLE "legal"."signatures" DROP COLUMN IF EXISTS envelope_id;');
    await q('DROP TABLE IF EXISTS "legal"."signature_envelopes";');
  },
};
