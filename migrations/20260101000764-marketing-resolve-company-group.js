'use strict';

/**
 * M9-D429 — marketing.resolve_company_group(company_id): função SECURITY DEFINER para a rota pública de descadastro de e-mail
 * (POST /marketing/unsubscribe) descobrir o grupo da empresa que consta no token assinado ANTES de abrir a sessão do tenant (mesmo padrão de
 * marketing.resolve_tracking_link). Devolve só o group_id e nunca lista empresas; o token assinado é a autorização. EXECUTE só para papéis de
 * runtime que existem (guarda de existência).
 */
module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql) => sequelize.query(sql, { transaction });
      await q('CREATE SCHEMA IF NOT EXISTS marketing');
      await q(`CREATE OR REPLACE FUNCTION marketing.resolve_company_group(p_company_id uuid)
        RETURNS uuid LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, core AS $f$
          SELECT c.group_id FROM core.companies c WHERE c.id = p_company_id LIMIT 1
        $f$`);
      await q('REVOKE ALL ON FUNCTION marketing.resolve_company_group(uuid) FROM PUBLIC');
      await q(`DO $$ DECLARE r text; BEGIN
        FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('nayara_runtime', 'nayara_ci', 'nayara_ci_app') LOOP
          EXECUTE format('GRANT EXECUTE ON FUNCTION marketing.resolve_company_group(uuid) TO %I', r);
        END LOOP;
      END $$`);
    });
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query('DROP FUNCTION IF EXISTS marketing.resolve_company_group(uuid)');
  },
};
