'use strict';

/**
 * Conferências de catálogo e de dinheiro do drill de restore de Obras (Marco 6, Caderno §13 DoD "restore verdes", §2 "RLS e
 * company_id obrigatórios"). Origem × destino, tabela a tabela do schema `construction` (e os lançamentos financeiros da obra):
 *   - somas de dinheiro: a soma de CADA coluna numérica (valores, quantidades, percentuais) é idêntica, centavo a centavo;
 *   - RLS: ENABLE + FORCE em todas, e as políticas (nome, comando, papéis, USING e WITH CHECK) idênticas, ao menos uma por tabela;
 *   - grants: os privilégios de tabela e de schema dos papéis da aplicação (nayara_runtime, nayara_analytics_reader,
 *     nayara_migration e PUBLIC) idênticos; o leitor do BI só com SELECT; atributos dos papéis (sem superusuário nem BYPASSRLS);
 *   - pertença de papel: o runtime continua membro de nayara_analytics_reader (o BI assume esse papel com SET LOCAL ROLE).
 * Exporta conferirCatalogo(src, dst, check): src/dst são clientes pg do superusuário; check(nome, ok, detalhe) registra.
 */

const PAPEIS = ['nayara_runtime', 'nayara_analytics_reader', 'nayara_migration', 'PUBLIC'];
const ESQUEMA = 'construction';

async function colunasNumericas(c) {
  const { rows } = await c.query(`SELECT table_name AS t, column_name AS col FROM information_schema.columns
    WHERE table_schema = $1 AND data_type IN ('numeric', 'integer', 'bigint', 'smallint', 'double precision', 'real') ORDER BY 1, 2`, [ESQUEMA]);
  return rows;
}

async function somas(c, cols) {
  const porTabela = {};
  for (const { t, col } of cols) {
    const { rows } = await c.query(`SELECT coalesce(sum("${col}"), 0)::text AS s FROM ${ESQUEMA}."${t}"`);
    (porTabela[t] = porTabela[t] || {})[col] = rows[0].s;
  }
  const { rows: fin } = await c.query(`SELECT coalesce(sum(amount), 0)::text AS total, count(*)::int AS n FROM finance.financial_entries WHERE construction_project_id IS NOT NULL`);
  porTabela['finance.financial_entries (da obra)'] = { amount: fin[0].total, linhas: String(fin[0].n) };
  return porTabela;
}

const politicas = async (c) => (await c.query(`SELECT tablename AS t, policyname AS nome, cmd, permissive, roles::text AS papeis, coalesce(qual, '') AS using_, coalesce(with_check, '') AS check_
  FROM pg_policies WHERE schemaname = $1 ORDER BY 1, 2`, [ESQUEMA])).rows;

const grantsDeTabela = async (c) => (await c.query(`SELECT table_name AS t, grantee AS papel, string_agg(privilege_type, ',' ORDER BY privilege_type) AS privs
  FROM information_schema.role_table_grants WHERE table_schema = $1 AND grantee = ANY($2::text[]) GROUP BY 1, 2 ORDER BY 1, 2`, [ESQUEMA, PAPEIS])).rows;

async function grantsDeSchema(c) {
  const { rows } = await c.query(`SELECT r.rolname AS papel, has_schema_privilege(r.rolname, $1, 'USAGE') AS uso, has_schema_privilege(r.rolname, $1, 'CREATE') AS criar
    FROM pg_roles r WHERE r.rolname = ANY($2::text[]) ORDER BY 1`, [ESQUEMA, PAPEIS]);
  return rows;
}

const atributos = async (c) => (await c.query(`SELECT rolname AS papel, rolsuper AS super, rolbypassrls AS bypass, rolcanlogin AS login
  FROM pg_roles WHERE rolname = ANY($1::text[]) ORDER BY 1`, [PAPEIS])).rows;

const pertencas = async (c) => (await c.query(`SELECT m.rolname AS membro, g.rolname AS grupo FROM pg_auth_members a
  JOIN pg_roles m ON m.oid = a.member JOIN pg_roles g ON g.oid = a.roleid WHERE g.rolname = ANY($1::text[]) OR m.rolname = ANY($1::text[]) ORDER BY 1, 2`, [PAPEIS])).rows;

const igual = (a, b) => JSON.stringify(a) === JSON.stringify(b);

async function conferirCatalogo(src, dst, check) {
  const cols = await colunasNumericas(src);
  const [sa, sb] = [await somas(src, cols), await somas(dst, cols)];
  const divergentes = Object.keys(sa).filter((t) => !igual(sa[t], sb[t]));
  check(`somas de dinheiro e quantidades idênticas (${cols.length} colunas numéricas de ${Object.keys(sa).length - 1} tabelas de Obras + lançamentos da obra)`,
    divergentes.length === 0, divergentes.length ? { divergentes: divergentes.map((t) => ({ tabela: t, origem: sa[t], destino: sb[t] })) } : `lançamentos da obra: R$ ${sb['finance.financial_entries (da obra)'].amount}`);

  const [pa, pb] = [await politicas(src), await politicas(dst)];
  const { rows: tabelas } = await dst.query("SELECT c.relname AS t FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relkind = 'r'", [ESQUEMA]);
  const semPolitica = tabelas.map((r) => r.t).filter((t) => !pb.some((p) => p.t === t));
  check('políticas RLS idênticas à origem (nome, comando, papéis, USING, WITH CHECK)', igual(pa, pb), `${pa.length} na origem, ${pb.length} no destino`);
  check('toda tabela de Obras tem ao menos uma política RLS no destino', semPolitica.length === 0, semPolitica.length ? { semPolitica } : `${tabelas.length} tabelas`);

  const [ga, gb] = [await grantsDeTabela(src), await grantsDeTabela(dst)];
  const resumo = (g, papel) => g.filter((x) => x.papel === papel).length;
  const nomesDeTabela = new Set(tabelas.map((r) => r.t)); // information_schema também lista as views do schema
  check('grants de tabela dos papéis da aplicação idênticos (nayara_runtime, nayara_analytics_reader, nayara_migration, PUBLIC)', igual(ga, gb),
    PAPEIS.map((p) => `${p}: ${resumo(gb, p)} tabela(s)/view(s)`).join('; '));
  const leitor = gb.filter((x) => x.papel === 'nayara_analytics_reader' && nomesDeTabela.has(x.t));
  check('nayara_analytics_reader lê todas as tabelas de Obras e só lê (SELECT, nada de escrita)', leitor.length === tabelas.length && leitor.every((x) => x.privs === 'SELECT'),
    { tabelas: tabelas.length, comSelect: leitor.length, outrosPrivilegios: leitor.filter((x) => x.privs !== 'SELECT') });
  const runtime = gb.filter((x) => x.papel === 'nayara_runtime' && nomesDeTabela.has(x.t));
  check('nayara_runtime com acesso às tabelas de Obras no destino', runtime.length === tabelas.length, `${runtime.length}/${tabelas.length}`);
  const [sca, scb] = [await grantsDeSchema(src), await grantsDeSchema(dst)];
  check('privilégios no schema construction (USAGE/CREATE) idênticos', igual(sca, scb), scb);
  const atr = await atributos(dst);
  check('papéis da aplicação no destino sem superusuário nem BYPASSRLS', atr.every((r) => !r.super && !r.bypass) && atr.length === PAPEIS.length - 1, atr);
  const [ma, mb] = [await pertencas(src), await pertencas(dst)];
  check('pertença de papéis idêntica (nayara_runtime membro de nayara_analytics_reader, como na origem)', igual(ma, mb), { origem: ma, destino: mb });
  return { somas: sb, politicas: pb.length, grants: gb, pertencas: mb };
}

module.exports = { conferirCatalogo };
