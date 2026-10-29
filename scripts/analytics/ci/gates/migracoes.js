'use strict';

/**
 * M9-D705 etapa 3 (migrations) — portão de RLS e GRANT: toda tabela do schema `analytics` precisa de RLS ENABLE + FORCE e de GRANT ao
 * `nayara_runtime`. `lerTabelasAnalytics` lê o catálogo do banco (já migrado); `avaliarTabelas` decide e é pura, para o teste provar a
 * reprovação com uma tabela fictícia sem RLS.
 */
const SQL = `
  SELECT 'analytics.' || c.relname AS tabela, c.relrowsecurity AS rls, c.relforcerowsecurity AS forcado,
         CASE WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nayara_runtime') THEN has_table_privilege('nayara_runtime', c.oid, 'SELECT') ELSE true END AS "grantRuntime"
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'analytics' AND c.relkind IN ('r', 'p') AND NOT c.relispartition
   ORDER BY c.relname`;

/** @param {(sql: string) => Promise<Array<{tabela: string, rls: boolean, forcado: boolean, grantRuntime: boolean}>>} query */
async function lerTabelasAnalytics(query) {
  return query(SQL);
}

function avaliarTabelas(linhas) {
  const problemas = [];
  for (const t of linhas) {
    if (!t.rls) problemas.push(`${t.tabela}: sem RLS (ENABLE ROW LEVEL SECURITY).`);
    else if (!t.forcado) problemas.push(`${t.tabela}: RLS sem FORCE (FORCE ROW LEVEL SECURITY).`);
    if (!t.grantRuntime) problemas.push(`${t.tabela}: sem GRANT ao nayara_runtime.`);
  }
  return { ok: problemas.length === 0, problemas };
}

module.exports = { lerTabelasAnalytics, avaliarTabelas };
