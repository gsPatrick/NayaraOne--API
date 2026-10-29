'use strict';

/**
 * M9-D841 — semente do consumidor INTERNAL/APP do front web (M9-D841 §3.1): uma linha por empresa existente, identificada pelo cabeçalho X-Client-App com o valor `nayara-web`
 * (coluna app_key), na major 1. O responsável é o usuário ativo mais antigo da empresa (empresa sem usuário não recebe a semente; o middleware semeia na primeira chamada). Empresas criadas
 * depois da migration ganham a linha do mesmo jeito na primeira chamada do front. As tabelas de empresa e vínculo têm FORCE RLS: o FORCE sai só durante a migration e volta ao estado
 * anterior no `finally`. Idempotente. O `down` nada faz: a tabela cai no `down` da migration 841, que roda depois dele.
 */
const WEB_APP_KEY = 'nayara-web';
const WEB_NAME = 'Front web Nayara One';

module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql, replacements) => sequelize.query(sql, { transaction, replacements });
      const [forced] = await q("SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'core' AND c.relname IN ('companies', 'user_memberships') AND c.relforcerowsecurity");
      const names = forced.map((row) => row.relname);
      for (const name of names) await q(`ALTER TABLE core.${name} NO FORCE ROW LEVEL SECURITY`);
      try {
        const [companies] = await q(`SELECT c.group_id AS "groupId", c.id AS "companyId",
            (SELECT m.user_id FROM core.user_memberships m WHERE m.company_id = c.id AND m.status = 'ACTIVE' AND m.deleted_at IS NULL ORDER BY m.created_at, m.id LIMIT 1) AS "ownerId"
          FROM core.companies c`);
        for (const company of companies.filter((row) => row.ownerId)) {
          await q("SELECT set_config('app.company_id', :companyId, true)", company); // a política da tabela exige a empresa da linha
          await q(`INSERT INTO governance.api_consumers (group_id, company_id, name, kind, owner_user_id, api_version_used, app_key, status)
            VALUES (:groupId, :companyId, :name, 'APP', :ownerId, 1, :appKey, 'ACTIVE') ON CONFLICT DO NOTHING`, { ...company, name: WEB_NAME, appKey: WEB_APP_KEY });
        }
      } finally {
        for (const name of names) await q(`ALTER TABLE core.${name} FORCE ROW LEVEL SECURITY`);
      }
    });
  },
  async down() {},
};
