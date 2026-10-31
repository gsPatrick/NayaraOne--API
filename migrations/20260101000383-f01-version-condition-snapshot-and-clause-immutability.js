'use strict';

/**
 * F01 (conferência Nayara 18/10/2026 — revisão independente 19/10):
 *
 * 1. legal.contract_versions ganha `condition_context` (contexto das cláusulas condicionais
 *    usado na geração: { source, values }) e `excluded_clauses` (cláusulas do modelo que ficaram
 *    de fora, com o motivo). A tabela já é append-only no banco (trigger da migration 171), então
 *    as colunas novas nascem imutáveis.
 *
 * 2. legal.contract_clauses ganha trigger BEFORE UPDATE: a biblioteca é append-only por versão,
 *    mas a regra só existia na aplicação. Depois de criada, uma versão só pode:
 *      - sair de circulação (is_active de true para false);
 *      - ter a condição aprovada (condition_status de PENDING_APPROVAL para APPROVED, junto com
 *        condition_approved_by/at, que só podem sair de NULL nesse mesmo passo).
 *    Texto, título, categoria, código, versão, regra (condition_json), autoria e tenant ficam
 *    imutáveis. DELETE não é bloqueado aqui (mesma decisão da migration 171: limpeza de tenant de
 *    teste/LGPD; a remoção deixa furo detectável na numeração e trilha na auditoria).
 */

const FUNCTION_SQL = `
  CREATE OR REPLACE FUNCTION legal.contract_clauses_guard_update()
  RETURNS trigger AS $$
  BEGIN
    IF NEW.id IS DISTINCT FROM OLD.id
      OR NEW.group_id IS DISTINCT FROM OLD.group_id
      OR NEW.company_id IS DISTINCT FROM OLD.company_id
      OR NEW.code IS DISTINCT FROM OLD.code
      OR NEW.title IS DISTINCT FROM OLD.title
      OR NEW.body_text IS DISTINCT FROM OLD.body_text
      OR NEW.category IS DISTINCT FROM OLD.category
      OR NEW.version_number IS DISTINCT FROM OLD.version_number
      OR NEW.condition_json IS DISTINCT FROM OLD.condition_json
      OR NEW.created_by IS DISTINCT FROM OLD.created_by
      OR NEW.created_at IS DISTINCT FROM OLD.created_at
    THEN
      RAISE EXCEPTION 'legal.contract_clauses é append-only por versão: texto, regra e identidade da cláusula % v% não podem ser alterados (crie uma nova versão).', OLD.code, OLD.version_number
        USING ERRCODE = '42501';
    END IF;

    IF NEW.is_active IS DISTINCT FROM OLD.is_active AND NOT (OLD.is_active = true AND NEW.is_active = false) THEN
      RAISE EXCEPTION 'legal.contract_clauses: uma versão retirada de circulação não volta a ficar ativa (cláusula % v%).', OLD.code, OLD.version_number
        USING ERRCODE = '42501';
    END IF;

    IF NEW.condition_status IS DISTINCT FROM OLD.condition_status
      OR NEW.condition_approved_by IS DISTINCT FROM OLD.condition_approved_by
      OR NEW.condition_approved_at IS DISTINCT FROM OLD.condition_approved_at
    THEN
      IF NOT (
        OLD.condition_status = 'PENDING_APPROVAL'
        AND NEW.condition_status = 'APPROVED'
        AND OLD.condition_approved_by IS NULL
        AND OLD.condition_approved_at IS NULL
        AND NEW.condition_approved_by IS NOT NULL
        AND NEW.condition_approved_at IS NOT NULL
        AND NEW.condition_approved_by IS DISTINCT FROM OLD.created_by
      ) THEN
        RAISE EXCEPTION 'legal.contract_clauses: a aprovação da condição só pode ir de PENDING_APPROVAL para APPROVED, uma única vez, por quem não criou a versão (cláusula % v%).', OLD.code, OLD.version_number
          USING ERRCODE = '42501';
      END IF;
    END IF;

    RETURN NEW;
  END;
  $$ LANGUAGE plpgsql;
`;

module.exports = {
  up: async (queryInterface, Sequelize) => {
    const versions = { tableName: 'contract_versions', schema: 'legal' };
    await queryInterface.addColumn(versions, 'condition_context', { type: Sequelize.JSONB, allowNull: true });
    await queryInterface.addColumn(versions, 'excluded_clauses', { type: Sequelize.JSONB, allowNull: true });

    await queryInterface.sequelize.query(FUNCTION_SQL);
    await queryInterface.sequelize.query('DROP TRIGGER IF EXISTS contract_clauses_append_only ON legal.contract_clauses;');
    await queryInterface.sequelize.query(`
      CREATE TRIGGER contract_clauses_append_only
      BEFORE UPDATE ON legal.contract_clauses
      FOR EACH ROW EXECUTE FUNCTION legal.contract_clauses_guard_update();
    `);
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query('DROP TRIGGER IF EXISTS contract_clauses_append_only ON legal.contract_clauses;');
    await queryInterface.sequelize.query('DROP FUNCTION IF EXISTS legal.contract_clauses_guard_update();');
    const versions = { tableName: 'contract_versions', schema: 'legal' };
    await queryInterface.removeColumn(versions, 'excluded_clauses');
    await queryInterface.removeColumn(versions, 'condition_context');
  },
};
