'use strict';

/**
 * M9-D612 (BI-001) — role de banco `nayara_analytics_reader`: só SELECT (nenhum INSERT/UPDATE/DELETE/TRUNCATE) em todas as tabelas
 * dos schemas da aplicação, inclusive finance, crm, construction, legal, correspondent, inventory e analytics. Os GET de
 * /analytics assumem este role (SET LOCAL ROLE) dentro da transação READ ONLY: duas camadas independentes contra escrita.
 *
 * Guardas: o role só é criado se o usuário da migration puder (senão aviso e segue: a transação READ ONLY continua valendo e a API
 * detecta a ausência do role); o GRANT ao nayara_runtime só roda se esse role existir. Default privileges cobrem tabelas e
 * schemas criados depois por quem roda a migration; `node scripts/aplicarPermissoesRuntime.js` reaplica o SELECT a tudo.
 * Idempotente. O down remove os privilégios e o role (sem tocar dado de nenhum schema).
 */
const ROLE = 'nayara_analytics_reader';

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      DO $$
      DECLARE s text;
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${ROLE}') THEN
          BEGIN
            CREATE ROLE ${ROLE} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOREPLICATION;
          EXCEPTION WHEN insufficient_privilege THEN
            RAISE NOTICE 'M9-D612: sem permissão para criar o role ${ROLE}; a API segue só com a transação READ ONLY.';
          END;
        END IF;
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${ROLE}') THEN
          FOR s IN SELECT nspname FROM pg_namespace WHERE nspname NOT LIKE 'pg\\_%' AND nspname <> 'information_schema' LOOP
            EXECUTE format('GRANT USAGE ON SCHEMA %I TO ${ROLE}', s);
            EXECUTE format('GRANT SELECT ON ALL TABLES IN SCHEMA %I TO ${ROLE}', s);
          END LOOP;
          -- M9-D698: a materialized view do BI (analytics.mv_*) não tem RLS; o leitor só a alcança pelas funções SECURITY DEFINER dela.
          FOR s IN SELECT matviewname FROM pg_matviews WHERE schemaname = 'analytics' AND matviewname LIKE 'mv\\_%' LOOP
            EXECUTE format('REVOKE ALL ON analytics.%I FROM ${ROLE}', s);
          END LOOP;
          ALTER DEFAULT PRIVILEGES GRANT SELECT ON TABLES TO ${ROLE};
          ALTER DEFAULT PRIVILEGES GRANT USAGE ON SCHEMAS TO ${ROLE};
          IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nayara_runtime') THEN
            GRANT ${ROLE} TO nayara_runtime;
          END IF;
        END IF;
      END $$;
    `);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${ROLE}') THEN
          IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nayara_runtime') THEN
            REVOKE ${ROLE} FROM nayara_runtime;
          END IF;
          DROP OWNED BY ${ROLE};
          BEGIN
            DROP ROLE ${ROLE};
          EXCEPTION WHEN OTHERS THEN
            RAISE NOTICE 'M9-D612: role ${ROLE} mantido (ainda tem dependências em outro banco do cluster): %', SQLERRM;
          END;
        END IF;
      END $$;
    `);
  },
};
