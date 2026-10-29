'use strict';

/**
 * Materialized view não tem RLS: a do BI (analytics.mv_*, M9-D698) guarda linhas de TODAS as empresas e só é lida pelas funções SECURITY DEFINER
 * que filtram pela empresa da sessão. O GRANT em massa por schema (aplicarPermissoesRuntime.js e o cluster descartável) concede SELECT em
 * tudo, inclusive nelas, ao role de runtime e ao role de leitura do BI (que o runtime assume nos GET); este passo tira o acesso dos dois de novo.
 * Cada view criada pela migration já nasce sem acesso. Rode DEPOIS de todos os GRANT.
 */
const ROLES = ['nayara_runtime', 'nayara_analytics_reader'];

const revokeMatviewSql = () => [
  `DO $$ DECLARE r record; v text; BEGIN
     FOR r IN SELECT schemaname, matviewname FROM pg_matviews WHERE schemaname = 'analytics' AND matviewname LIKE 'mv\\_%' LOOP
       FOREACH v IN ARRAY ARRAY['${ROLES.join("','")}'] LOOP
         IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = v) THEN
           EXECUTE format('REVOKE ALL ON %I.%I FROM %I', r.schemaname, r.matviewname, v);
         END IF;
       END LOOP;
     END LOOP;
   END $$`,
];

module.exports = { revokeMatviewSql, ROLES };
