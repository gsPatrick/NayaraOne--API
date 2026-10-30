'use strict';

/**
 * Marco 9, M9-D227 — colunas da contingência nos domínios (sem tabela nova).
 *  - crm.messages: alternate_channel (EMAIL ou o código do outro fornecedor de mensagens), alternate_ref (id da mensagem do canal alternativo ou do envio novo) e alternate_at: a conversa mostra
 *    "enviada por canal alternativo" quando o WhatsApp principal estava fora.
 *  - real_estate.portal_listings: pending_sync_since (desde quando o anúncio espera o portal voltar) e pending_task_at (a tarefa ao marketing sai uma única vez, passadas 24 h).
 *  - legal.signature_envelopes: estado SUPERSEDED (troca de fornecedor de assinatura: o envelope anterior foi substituído e cancelado por compensação) e superseded_by.
 *  - legal.signatures: evidence_type (PROVIDER_EVENT, MANUAL_UPLOAD). As assinaturas manuais anteriores, que já exigiam o arquivo da via assinada e o coletor (CHECK do banco),
 *    ficam marcadas como MANUAL_UPLOAD com evidência completa.
 */
const ESTADOS_ENVELOPE = ['PENDING', 'SIGNED', 'CANCELLED', 'HASH_MISMATCH'];

module.exports = {
  up: async (queryInterface) => {
    const q = (sql) => queryInterface.sequelize.query(sql);
    await q(`ALTER TABLE "crm"."messages" ADD COLUMN IF NOT EXISTS alternate_channel varchar(48), ADD COLUMN IF NOT EXISTS alternate_ref varchar(64), ADD COLUMN IF NOT EXISTS alternate_at timestamptz;`);
    await q(`ALTER TABLE "real_estate"."portal_listings" ADD COLUMN IF NOT EXISTS pending_sync_since timestamptz, ADD COLUMN IF NOT EXISTS pending_task_at timestamptz;`);
    await q('CREATE INDEX IF NOT EXISTS portal_listings_pending_sync_idx ON "real_estate"."portal_listings" (company_id, pending_sync_since) WHERE status = \'PENDING_SYNC\' AND superseded_at IS NULL;');
    await q('ALTER TABLE "legal"."signature_envelopes" DROP CONSTRAINT IF EXISTS signature_envelopes_status_check;');
    await q(`ALTER TABLE "legal"."signature_envelopes" ADD CONSTRAINT signature_envelopes_status_check CHECK (status IN (${[...ESTADOS_ENVELOPE, 'SUPERSEDED'].map((e) => `'${e}'`).join(', ')}));`);
    await q('ALTER TABLE "legal"."signature_envelopes" ADD COLUMN IF NOT EXISTS superseded_by uuid REFERENCES "legal"."signature_envelopes"(id) ON DELETE SET NULL ON UPDATE CASCADE;');
    await q('ALTER TABLE "legal"."signatures" ADD COLUMN IF NOT EXISTS evidence_type varchar(24);');
    await q("UPDATE \"legal\".\"signatures\" SET evidence_type = 'MANUAL_UPLOAD', evidence_complete = true WHERE signature_method = 'MANUAL' AND evidence_file_id IS NOT NULL AND evidence_type IS NULL;");
    await q("UPDATE \"legal\".\"signatures\" SET evidence_type = 'PROVIDER_EVENT' WHERE signature_method <> 'MANUAL' AND evidence_json IS NOT NULL AND evidence_type IS NULL;");
  },

  down: async (queryInterface) => {
    const q = (sql) => queryInterface.sequelize.query(sql);
    await q('ALTER TABLE "legal"."signatures" DROP COLUMN IF EXISTS evidence_type;');
    await q('ALTER TABLE "legal"."signature_envelopes" DROP COLUMN IF EXISTS superseded_by;');
    await q("UPDATE \"legal\".\"signature_envelopes\" SET status = 'CANCELLED' WHERE status = 'SUPERSEDED';");
    await q('ALTER TABLE "legal"."signature_envelopes" DROP CONSTRAINT IF EXISTS signature_envelopes_status_check;');
    await q(`ALTER TABLE "legal"."signature_envelopes" ADD CONSTRAINT signature_envelopes_status_check CHECK (status IN (${ESTADOS_ENVELOPE.map((e) => `'${e}'`).join(', ')}));`);
    await q('DROP INDEX IF EXISTS "real_estate".portal_listings_pending_sync_idx;');
    await q('ALTER TABLE "real_estate"."portal_listings" DROP COLUMN IF EXISTS pending_task_at, DROP COLUMN IF EXISTS pending_sync_since;');
    await q('ALTER TABLE "crm"."messages" DROP COLUMN IF EXISTS alternate_at, DROP COLUMN IF EXISTS alternate_ref, DROP COLUMN IF EXISTS alternate_channel;');
  },
};
