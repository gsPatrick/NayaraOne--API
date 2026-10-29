'use strict';

/** Estágio 3 (migrations): toda tabela do schema `ai` precisa de RLS + FORCE RLS, ao menos uma política e GRANT de leitura DIRETO ao nayara_runtime (herança de outro papel não vale). */
const SQL = `SELECT c.relname AS tabela, c.relrowsecurity AS rls, c.relforcerowsecurity AS force_rls,
  (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid) AS politicas,
  CASE WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nayara_runtime') THEN
    EXISTS (SELECT 1 FROM aclexplode(COALESCE(c.relacl, '{}'::aclitem[])) a JOIN pg_roles r ON r.oid = a.grantee WHERE r.rolname = 'nayara_runtime' AND a.privilege_type = 'SELECT') END AS leitura_runtime
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'ai' AND c.relkind IN ('r', 'p') AND NOT c.relispartition ORDER BY c.relname`;

/** `consulta(sql)` devolve as linhas. Devolve a lista de problemas (vazia = tudo certo). */
async function problemasDasTabelasAi(consulta) {
  const linhas = await consulta(SQL);
  if (!linhas.length) return ['o schema ai não tem nenhuma tabela: as migrations não foram aplicadas'];
  const problemas = [];
  for (const t of linhas) {
    if (!t.rls) problemas.push(`ai.${t.tabela}: sem ROW LEVEL SECURITY`);
    if (!t.force_rls) problemas.push(`ai.${t.tabela}: sem FORCE ROW LEVEL SECURITY`);
    if (!t.politicas) problemas.push(`ai.${t.tabela}: sem nenhuma política RLS`);
    if (t.leitura_runtime === null) problemas.push(`ai.${t.tabela}: role nayara_runtime ausente, GRANT não conferível`);
    else if (!t.leitura_runtime) problemas.push(`ai.${t.tabela}: sem GRANT de leitura ao nayara_runtime`);
  }
  return problemas;
}

module.exports = { problemasDasTabelasAi };
