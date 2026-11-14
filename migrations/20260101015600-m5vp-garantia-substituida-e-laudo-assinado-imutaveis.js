'use strict';

/**
 * Fechamento M5 (vistorias e prazos) — duas travas do banco, por baixo das do serviço:
 *  1. Livro §9 "contrato não perde histórico quando a garantia é substituída": a garantia que já foi substituída
 *     (replaced_by_guarantee_id preenchido) não é mais alterada nem apagada (nem exclusão lógica, que é um UPDATE de
 *     deleted_at). O gatilho só olha a linha ANTIGA: a própria troca (que preenche replaced_by_guarantee_id) passa.
 *  2. Livro §11 "Correção após assinatura cria addendum/revision, não altera laudo original": depois que locador e
 *     locatário assinaram a vistoria e o laudo foi emitido (report_generated_at a partir da última dessas assinaturas),
 *     report_pdf_bytes e report_hash não mudam mais. Laudo emitido antes da assinatura completa ainda pode ser emitido
 *     de novo uma vez, já com as assinaturas.
 * Não mexe em dado nenhum (só cria função e gatilho). Reversível.
 */
module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql) => sequelize.query(sql, { transaction });
      await q(`CREATE OR REPLACE FUNCTION legal.guarantee_substituida_imutavel() RETURNS trigger LANGUAGE plpgsql AS $f$
        BEGIN
          IF OLD.replaced_by_guarantee_id IS NOT NULL THEN
            RAISE EXCEPTION 'LEGAL_GUARANTEE_REPLACED_IMMUTABLE: a garantia % foi substituida e faz parte do historico do contrato', OLD.id
              USING ERRCODE = 'check_violation';
          END IF;
          IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
          RETURN NEW;
        END $f$`);
      await q('DROP TRIGGER IF EXISTS guarantees_substituida_imutavel ON legal.guarantees');
      await q(`CREATE TRIGGER guarantees_substituida_imutavel BEFORE UPDATE OR DELETE ON legal.guarantees
        FOR EACH ROW EXECUTE FUNCTION legal.guarantee_substituida_imutavel()`);

      await q(`CREATE OR REPLACE FUNCTION legal.inspection_laudo_assinado_imutavel() RETURNS trigger LANGUAGE plpgsql AS $f$
        DECLARE
          papeis integer;
          assinada_em timestamptz;
        BEGIN
          IF OLD.report_hash IS NULL THEN RETURN NEW; END IF;
          IF NEW.report_hash IS NOT DISTINCT FROM OLD.report_hash AND NEW.report_pdf_bytes IS NOT DISTINCT FROM OLD.report_pdf_bytes THEN
            RETURN NEW;
          END IF;
          SELECT count(DISTINCT party_role), max(signed_at) INTO papeis, assinada_em
            FROM legal.inspection_signatures
           WHERE inspection_id = OLD.id AND party_role IN ('LANDLORD', 'TENANT');
          IF papeis = 2 AND OLD.report_generated_at IS NOT NULL AND OLD.report_generated_at >= assinada_em THEN
            RAISE EXCEPTION 'LEGAL_INSPECTION_REPORT_FROZEN: o laudo da vistoria % assinada nao pode ser regravado', OLD.id
              USING ERRCODE = 'check_violation';
          END IF;
          RETURN NEW;
        END $f$`);
      await q('DROP TRIGGER IF EXISTS inspections_laudo_assinado_imutavel ON legal.inspections');
      await q(`CREATE TRIGGER inspections_laudo_assinado_imutavel BEFORE UPDATE OF report_hash, report_pdf_bytes ON legal.inspections
        FOR EACH ROW EXECUTE FUNCTION legal.inspection_laudo_assinado_imutavel()`);
    });
  },

  async down(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql) => sequelize.query(sql, { transaction });
      await q('DROP TRIGGER IF EXISTS inspections_laudo_assinado_imutavel ON legal.inspections');
      await q('DROP FUNCTION IF EXISTS legal.inspection_laudo_assinado_imutavel()');
      await q('DROP TRIGGER IF EXISTS guarantees_substituida_imutavel ON legal.guarantees');
      await q('DROP FUNCTION IF EXISTS legal.guarantee_substituida_imutavel()');
    });
  },
};
