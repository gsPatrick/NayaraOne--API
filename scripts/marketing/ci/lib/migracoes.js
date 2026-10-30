'use strict';

/**
 * Estágio 3 (migrations) do Marketing (M9-D438): as 15 tabelas do livro (6 do núcleo da M9-D400 e 9 da execução da M9-D401) existem e TODA tabela do schema `marketing` (as 15 e as que as
 * demandas seguintes criaram) tem RLS e FORCE RLS, ao menos uma política e GRANT de leitura DIRETO ao nayara_runtime (herança de outro papel não vale).
 */
const TABELAS_DO_LIVRO = Object.freeze([
  'campaigns', 'campaign_audiences', 'campaign_steps', 'content_items', 'content_versions', 'templates',
  'publication_jobs', 'publication_results', 'automation_flows', 'automation_versions', 'automation_runs', 'suppression_list', 'tracking_links', 'attribution_events', 'review_requests',
]);

const SQL = `SELECT c.relname AS tabela, c.relrowsecurity AS rls, c.relforcerowsecurity AS force_rls,
  (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid) AS politicas,
  CASE WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nayara_runtime') THEN
    EXISTS (SELECT 1 FROM aclexplode(COALESCE(c.relacl, '{}'::aclitem[])) a JOIN pg_roles r ON r.oid = a.grantee WHERE r.rolname = 'nayara_runtime' AND a.privilege_type = 'SELECT') END AS leitura_runtime
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'marketing' AND c.relkind IN ('r', 'p') AND NOT c.relispartition ORDER BY c.relname`;

/** `consulta(sql)` devolve as linhas. Devolve a lista de problemas (vazia = tudo certo). */
async function problemasDasTabelasMarketing(consulta) {
  const linhas = await consulta(SQL);
  if (!linhas.length) return ['o schema marketing não tem nenhuma tabela: as migrations não foram aplicadas'];
  const problemas = TABELAS_DO_LIVRO.filter((nome) => !linhas.some((l) => l.tabela === nome)).map((nome) => `marketing.${nome}: tabela do livro ausente`);
  for (const t of linhas) {
    if (!t.rls) problemas.push(`marketing.${t.tabela}: sem ROW LEVEL SECURITY`);
    if (!t.force_rls) problemas.push(`marketing.${t.tabela}: sem FORCE ROW LEVEL SECURITY`);
    if (!t.politicas) problemas.push(`marketing.${t.tabela}: sem nenhuma política RLS`);
    if (t.leitura_runtime === null) problemas.push(`marketing.${t.tabela}: role nayara_runtime ausente, GRANT não conferível`);
    else if (!t.leitura_runtime) problemas.push(`marketing.${t.tabela}: sem GRANT de leitura ao nayara_runtime`);
  }
  return problemas;
}

module.exports = { TABELAS_DO_LIVRO, problemasDasTabelasMarketing };
