'use strict';

/**
 * Lookup seguro de roteamento para o webhook público de seguradora (Marco 7).
 * A tabela "procurement"."insurance_provider_submissions" mantém RLS e FORCE RLS ativos.
 * Esta função SECURITY DEFINER permite que a rota pública anônima do webhook localize
 * estritamente o group_id e company_id da submissão para inicializar a sessão do tenant
 * antes de validar HMAC e processar a liquidação.
 */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      CREATE OR REPLACE FUNCTION procurement.resolve_insurance_submission_routing(p_external_submission_id text)
      RETURNS TABLE (
        id uuid,
        group_id uuid,
        company_id uuid,
        policy_id uuid,
        claim_id uuid,
        provider varchar,
        submission_type varchar,
        external_submission_id varchar,
        status varchar
      )
      LANGUAGE sql
      SECURITY DEFINER
      SET search_path = procurement, pg_temp
      AS $$
        SELECT s.id, s.group_id, s.company_id, s.policy_id, s.claim_id, s.provider, s.submission_type, s.external_submission_id, s.status
        FROM procurement.insurance_provider_submissions s
        WHERE s.external_submission_id = p_external_submission_id
        LIMIT 1;
      $$;
    `);

    // Concede EXECUTE para nayara_runtime e roles conhecidas
    const [roles] = await queryInterface.sequelize.query(`
      SELECT rolname FROM pg_roles WHERE rolname IN ('nayara_runtime', 'nayara_ci', 'nayara_ci_app', 'postgres');
    `);
    for (const r of roles) {
      await queryInterface.sequelize.query(
        `GRANT EXECUTE ON FUNCTION procurement.resolve_insurance_submission_routing(text) TO ${r.rolname};`
      );
    }
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`
      DROP FUNCTION IF EXISTS procurement.resolve_insurance_submission_routing(text);
    `);
  },
};
