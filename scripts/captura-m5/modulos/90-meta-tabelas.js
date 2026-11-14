'use strict';
/**
 * Marco 5, caderno §4 (Entidades/tabelas obrigatórias): para cada uma das 21 tabelas do livro,
 * a consulta de catálogo (existe? é tabela? company_id? RLS ENABLE+FORCE?) e a rota HTTP real que
 * lê a entidade. Onde o nome físico difere do livro, a consulta mostra também a tabela que guarda
 * a entidade hoje (o requisito fica DIVERGENTE na matriz até o rename).
 */
const LIVRO = [
  ['M5-A0030-d468ae', 'contracts', null, '/legal/contracts'],
  ['M5-A0031-69a4ea', 'contract_versions', null, (c) => `/legal/contracts/${c.mt.ct}/versions`],
  ['M5-A0032-0045b7', 'contract_parties', null, (c) => `/legal/contracts/${c.mt.ct}/parties`],
  ['M5-A0033-0233b3', 'contract_templates', null, '/legal/contract-templates'],
  ['M5-A0034-a144b2', 'template_versions', null, '/legal/contract-templates'],
  ['M5-A0035-4c42f0', 'clause_library', null, '/legal/clauses'],
  ['M5-A0036-7f8c9b', 'clause_versions', null, (c) => `/legal/clauses/${encodeURIComponent(c.mt.clCode)}/versions`],
  ['M5-A0037-f9f799', 'contract_requirements', null, (c) => `/legal/contracts/${c.mt.ct}/requirements`],
  ['M5-A0038-6f5422', 'signatures', null, (c) => `/legal/contracts/${c.mt.ct}/timeline`],
  ['M5-A0039-6ce543', 'addenda', null, (c) => `/legal/contracts/${c.mt.ct}/amendments`],
  ['M5-A0040-7ac2ac', 'guarantees', null, '/legal/guarantees'],
  ['M5-A0041-a18689', 'key_deliveries', null, '/legal/key-deliveries'],
  ['M5-A0042-bd96c7', 'inspections', null, '/legal/inspections'],
  ['M5-A0043-d8731f', 'inspection_items', null, '/legal/inspections'],
  ['M5-A0044-2df892', 'inspection_media', null, '/legal/inspections'],
  ['M5-A0045-eb7284', 'lease_obligations', null, '/billing/utility-obligations'],
  ['M5-A0046-1138c0', 'notices', null, '/legal/notices'],
  ['M5-A0047-64780b', 'legal_cases', null, '/legal/cases'],
  ['M5-A0048-193c7d', 'case_parties', null, (c) => `/legal/cases/${c.mt.cs}`],
  ['M5-A0049-9aa2d7', 'legal_deadlines', null, '/legal/deadlines'],
  ['M5-A0050-1f193f', 'evidence_packages', null, (c) => `/legal/cases/${c.mt.cs}/evidence-packages`],
];

const SQL_TABELA = `
SELECT :nome AS tabela_do_livro,
       to_regclass(:nome) IS NOT NULL AS existe_com_o_nome_do_livro,
       c.relkind::text AS tipo, c.relrowsecurity AS rls_enable, c.relforcerowsecurity AS rls_force,
       EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'company_id' AND NOT a.attisdropped) AS tem_company_id,
       :fisica AS tabela_que_guarda_hoje,
       f.relkind::text AS tipo_da_que_guarda, f.relrowsecurity AS rls_enable_da_que_guarda, f.relforcerowsecurity AS rls_force_da_que_guarda
  FROM (SELECT 1) x
  LEFT JOIN pg_class c ON c.oid = to_regclass(:nome)
  LEFT JOIN pg_class f ON f.oid = to_regclass(:fisica)`;

module.exports = async function metaTabelas(R) {
  const sfx = String(Date.now()).slice(-7);
  R.ctx.mt = {};
  const mt = R.ctx.mt;
  const prep = ['M5-A0030-d468ae'];
  await R.http({ id: 'MT-PREP-1', req: prep, titulo: 'Preparação: contrato de locação para as leituras por contrato', quem: 'A:gestor', metodo: 'POST', rota: '/legal/contracts', corpo: { contractType: 'LEASE_RESIDENTIAL', totalValue: 1800 }, esperado: { status: 201 }, guardar: (b) => { mt.ct = b.data.id; } });
  await R.http({ id: 'MT-PREP-2', req: ['M5-A0035-4c42f0'], titulo: 'Preparação: cláusula da biblioteca', quem: 'A:maker', metodo: 'POST', rota: '/legal/clauses', corpo: { code: `MT-${sfx}`, title: 'Cláusula de inventário', bodyText: 'Texto fictício da cláusula de inventário.', category: 'GENERAL' }, esperado: { status: 201 }, guardar: (b) => { mt.clCode = b.data.code; } });
  await R.http({ id: 'MT-PREP-3', req: ['M5-A0047-64780b'], titulo: 'Preparação: processo jurídico', quem: 'A:gestor', metodo: 'POST', rota: '/legal/cases', corpo: { caseType: 'LITIGATION', summary: `Processo de inventário ${sfx}` }, esperado: { status: 201 }, guardar: (b) => { mt.cs = b.data.id; } });

  let n = 0;
  for (const [req, nome, fisica, rota] of LIVRO) {
    n += 1;
    const id = String(n).padStart(2, '0');
    const qualificado = `legal.${nome}`;
    await R.sqlCatalogo({
      id: `MT-T${id}-SQL`,
      req: [req],
      descricao: `Catálogo: ${qualificado} existe com o nome do livro, é tabela (relkind r), tem company_id e RLS ENABLE+FORCE${fisica ? `; e a tabela que guarda a entidade hoje (${fisica})` : ''}`,
      sql: SQL_TABELA.replace(/:nome/g, `'${qualificado}'`).replace(/:fisica/g, fisica ? `'${fisica}'` : 'NULL'),
      avaliar: (r) => (fisica ? r.length === 1 : r.length === 1 && r[0].existe_com_o_nome_do_livro && r[0].tipo === 'r' && r[0].rls_enable && r[0].rls_force && r[0].tem_company_id),
    });
    await R.http({ id: `MT-T${id}-GET`, req: [req], titulo: `Rota real que lê a entidade de ${qualificado} (perfil de gestão da empresa A)`, quem: 'A:gestor', metodo: 'GET', rota, esperado: { status: 200 } });
  }
  await R.http({ id: 'MT-T-ANON', req: LIVRO.map((x) => x[0]), titulo: 'Sem login a leitura do módulo é recusada', quem: 'anonimo', metodo: 'GET', rota: '/legal/contracts', esperado: { status: 401 } });
  await R.http({ id: 'MT-T-B404', req: ['M5-A0030-d468ae', 'M5-A0047-64780b'], titulo: 'Empresa B não lê o contrato da empresa A (RLS)', quem: 'B:gestor', metodo: 'GET', rota: (c) => `/legal/contracts/${c.mt.ct}`, esperado: { status: 404 } });
  await R.sqlTenant({ id: 'MT-T-RLSB', req: LIVRO.map((x) => x[0]), quem: 'B:gestor', descricao: 'No contexto da empresa B, o contrato e o processo da empresa A não aparecem nem por SQL direto (RLS)', sql: 'SELECT (SELECT count(*)::int FROM legal.contracts WHERE id = :ct) AS contratos_da_a_visiveis, (SELECT count(*)::int FROM legal.legal_cases WHERE id = :cs) AS processos_da_a_visiveis', replacements: (c) => ({ ct: c.mt.ct, cs: c.mt.cs }), avaliar: (r) => r[0].contratos_da_a_visiveis === 0 && r[0].processos_da_a_visiveis === 0 });
  await R.sqlCatalogo({ id: 'MT-T-INV', req: LIVRO.map((x) => x[0]), descricao: 'Inventário de todas as tabelas do schema legal com RLS ENABLE/FORCE', sql: "SELECT c.relname AS tabela, c.relkind::text AS tipo, c.relrowsecurity AS rls_enable, c.relforcerowsecurity AS rls_force FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'legal' AND c.relkind IN ('r','v','p') ORDER BY 1", avaliar: (r) => r.length > 0 });
};
