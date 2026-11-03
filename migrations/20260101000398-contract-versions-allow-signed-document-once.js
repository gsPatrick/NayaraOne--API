'use strict';

/**
 * BUG REAL encontrado pelo drill de restore jurídico (F05, 18/10/2026): o trigger append-only de
 * legal.contract_versions (migration 171) bloqueia QUALQUER UPDATE. A migration 180 criou
 * `signed_document_file_id`, preenchido por signatures.service.js#handleEnvelopeClosedWebhook
 * quando o provedor fecha o envelope — mas esse UPDATE sempre levantava "contract_versions é
 * append-only". Ou seja, o PDF assinado nunca podia ser vinculado à versão pelo caminho real.
 *
 * Correção: o trigger continua recusando qualquer alteração do documento da versão (conteúdo,
 * hash, número, modelo, cláusulas, contexto, documento original...), mas aceita UMA única
 * transição: `signed_document_file_id` de NULL para um arquivo (com `updated_by`/`updated_at`
 * acompanhando). Trocar ou remover um documento assinado já gravado continua bloqueado.
 * A comparação é feita sobre a linha inteira em JSONB, então qualquer coluna futura também fica
 * protegida por padrão.
 */
module.exports = {
  up: async (queryInterface) => {
    await queryInterface.sequelize.query(`
      CREATE OR REPLACE FUNCTION legal.contract_versions_block_update()
      RETURNS trigger AS $$
      BEGIN
        IF (to_jsonb(NEW) - ARRAY['signed_document_file_id', 'updated_by', 'updated_at'])
           IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['signed_document_file_id', 'updated_by', 'updated_at']) THEN
          RAISE EXCEPTION 'legal.contract_versions é append-only: UPDATE não é permitido (versão %, contrato %).',
            OLD.version_number, OLD.contract_id
            USING ERRCODE = '42501';
        END IF;
        IF NEW.signed_document_file_id IS DISTINCT FROM OLD.signed_document_file_id
           AND (OLD.signed_document_file_id IS NOT NULL OR NEW.signed_document_file_id IS NULL) THEN
          RAISE EXCEPTION 'legal.contract_versions: o documento assinado só pode ser vinculado uma vez e nunca trocado/removido (versão %, contrato %).',
            OLD.version_number, OLD.contract_id
            USING ERRCODE = '42501';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `);
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query(`
      CREATE OR REPLACE FUNCTION legal.contract_versions_block_update()
      RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'legal.contract_versions é append-only: UPDATE não é permitido (versão %, contrato %).',
          OLD.version_number, OLD.contract_id
          USING ERRCODE = '42501';
      END;
      $$ LANGUAGE plpgsql;
    `);
  },
};
