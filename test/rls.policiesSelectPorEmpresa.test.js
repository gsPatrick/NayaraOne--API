'use strict';

// Guarda de catálogo contra o defeito achado em people.persons (10/11/2026): no PostgreSQL, política FOR ALL vale também
// para SELECT e políticas PERMISSIVAS se somam com OR. Uma política FOR ALL só por group_id, ao lado de uma de SELECT por
// empresa, abre a leitura para o grupo inteiro.
//
// Versão reforçada (ISO-5 da verificação de 11/11/2026): procurar o texto "company_id" no predicado não basta (aceitaria
// "company_id IS NULL OR group_id = ..."). Agora o predicado é decomposto em AND/OR no nível de cima, respeitando parênteses,
// e cada política permissiva que vale para SELECT numa tabela com company_id precisa:
// - ter, entre os termos do AND, a restrição da empresa do contexto (company_id = app.company_id ou company_scope_allows); ou
// - ser um OR em que TODO ramo é restrito à empresa do contexto, é linha compartilhada sem empresa (company_id IS NULL), ou é um
//   dos ramos de vínculo de people.persons (vínculo ACTIVE da empresa do contexto ou a prova CPF + nome; DI-M9I-1).
// Exceções (lookups por token/usuário e a checagem do dono do vínculo) ficam listadas com o predicado exato e os papéis.
// Tabelas sem company_id que têm política de leitura também ficam numa lista fechada, e nenhuma delas pode ter person_id.

const { test, after } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize } = require('./testHelpers');

after(async () => { await sequelize.close(); });

const CTX_EMPRESA = "\\(NULLIF\\(current_setting\\('app\\.company_id'::text, true\\), ''::text\\)\\)::uuid";
const CTX_GRUPO = "\\(NULLIF\\(current_setting\\('app\\.group_id'::text, true\\), ''::text\\)\\)::uuid";
const RESTRICAO_EMPRESA = [
  new RegExp(`^company_id = ${CTX_EMPRESA}$`),
  new RegExp(`^company_scope_allows\\(company_id, ${CTX_EMPRESA}\\)$`),
];
const LINHA_SEM_EMPRESA = /^company_id IS NULL$/;
// Ramos de people.persons (migration 20260101010940): vínculo ACTIVE da empresa do contexto e prova de conhecimento (CPF + nome).
const RAMOS_PESSOA = [
  new RegExp(`^EXISTS \\( SELECT 1 FROM people\\.person_company_links l WHERE \\(\\(l\\.person_id = persons\\.id\\) AND \\(l\\.company_id = ${CTX_EMPRESA}\\) AND \\(\\(l\\.status\\)::text = 'ACTIVE'::text\\)\\)\\)$`),
  new RegExp(`^\\(tax_id_normalized IS NOT NULL\\) AND \\(${CTX_EMPRESA} IS NOT NULL\\) AND \\(\\(tax_id_normalized\\)::text = NULLIF\\(current_setting\\('app\\.vinculo_documento'::text, true\\), ''::text\\)\\) AND \\(people\\.chave_nome\\(\\(legal_name\\)::text\\) = people\\.chave_nome\\(NULLIF\\(current_setting\\('app\\.vinculo_nome'::text, true\\), ''::text\\)\\)\\) AND \\(deleted_at IS NULL\\) AND \\(\\(status\\)::text <> 'MERGED'::text\\)$`),
];

const LOOKUPS_DELIBERADOS = {
  // A pessoa lê as PRÓPRIAS associações (login e troca de empresa), antes de ter empresa no contexto.
  'core.user_memberships:self_membership_lookup': /^\(user_id = \(NULLIF\(current_setting\('app\.user_id'::text, true\), ''::text\)\)::uuid\)$/,
  // Autenticação de cliente de API pela chave: só com o interruptor de lookup ligado pelo middleware de API.
  'governance.api_clients:api_client_lookup': /^\(current_setting\('app\.api_client_lookup'::text, true\) = 'on'::text\)$/,
  'governance.api_consumers:api_consumer_client_lookup': /^\(\(current_setting\('app\.api_client_lookup'::text, true\) = 'on'::text\) AND \(client_id IS NOT NULL\)\)$/,
  // Link público compartilhado: acha só a linha do hash do token apresentado.
  'governance.share_links:share_token_lookup': /^\(\(token_hash\)::text = NULLIF\(current_setting\('app\.share_token_hash'::text, true\), ''::text\)\)$/,
  // Webhook de entrada: acha só a conexão do canal apresentado.
  'integration.connections:webhook_channel_lookup': /^\(\(webhook_channel IS NOT NULL\) AND \(\(webhook_channel\)::text = NULLIF\(current_setting\('app\.webhook_channel_lookup'::text, true\), ''::text\)\)\)$/,
  // Só o dono das tabelas (quem roda as migrations), dentro de people.pessoa_vinculada_em_outra_empresa: nunca o runtime.
  'people.person_company_links:person_company_links_checagem_do_dono': /^true$/,
};
const PAPEIS_DA_APLICACAO = ['public', 'nayara_runtime', 'nayara_ci', 'nayara_ci_app', 'nayara_analytics_reader'];

// Tabelas SEM company_id com política de leitura (catálogos, linhagem do grupo e contadores por interruptor). Lista fechada.
const SEM_EMPRESA = {
  'analytics.tech_signal_log:tech_signal_select': /^\(COALESCE\(current_setting\('app\.analytics_writer'::text, true\), ''::text\) = 'on'::text\)$/,
  'core.companies:tenant_isolation': new RegExp(`^\\(group_id = ${CTX_GRUPO}\\)$`),
  'governance.api_scopes:api_scopes_catalog_write': /^\(current_setting\('app\.api_scope_catalog'::text, true\) = 'on'::text\)$/,
  'governance.api_scopes:api_scopes_read': /^true$/,
  'governance.bcp_form_templates:bcp_form_templates_read': /^true$/,
  'governance.bcp_sectors:bcp_sectors_read': /^true$/,
  'governance.error_catalog:error_catalog_sync': /^\(current_setting\('app\.error_catalog_sync'::text, true\) = 'on'::text\)$/,
  'governance.error_catalog:error_catalog_read': /^true$/,
  'governance.lineage_edges:tenant_isolation': new RegExp(`^\\(group_id = ${CTX_GRUPO}\\)$`),
  'governance.lineage_nodes:tenant_isolation': new RegExp(`^\\(group_id = ${CTX_GRUPO}\\)$`),
  'governance.lineage_seed_state:tenant_isolation': new RegExp(`^\\(group_id = ${CTX_GRUPO}\\)$`),
  'governance.public_access_counters:public_counter_writer': /^\(current_setting\('app\.public_counter'::text, true\) = 'on'::text\)$/,
  'governance.rate_limit_counters:rate_limit_writer': /^\(current_setting\('app\.rate_limit'::text, true\) = 'on'::text\)$/,
  'integration.platform_unknown_webhooks:platform_only': /^\(current_setting\('app\.integration_platform_admin'::text, true\) = 'on'::text\)$/,
  'integration.providers:providers_read': /^true$/,
};

/** Tira os parênteses que envolvem a expressão inteira. */
function semParentesesExternos(expr) {
  let e = String(expr).replace(/\s+/g, ' ').trim();
  for (;;) {
    if (!e.startsWith('(') || !e.endsWith(')')) return e;
    let nivel = 0; let fechaNoFim = true;
    for (let i = 0; i < e.length; i += 1) {
      if (e[i] === "'") { i = e.indexOf("'", i + 1); if (i < 0) return e; continue; }
      if (e[i] === '(') nivel += 1;
      if (e[i] === ')') { nivel -= 1; if (nivel === 0 && i < e.length - 1) { fechaNoFim = false; break; } }
    }
    if (!fechaNoFim) return e;
    e = e.slice(1, -1).trim();
  }
}

/** Separa no operador (AND ou OR) do nível de cima, fora de parênteses e de literais. */
function separar(expr, operador) {
  const e = semParentesesExternos(expr);
  const partes = []; let nivel = 0; let inicio = 0; const sep = ` ${operador} `;
  for (let i = 0; i < e.length; i += 1) {
    if (e[i] === "'") { i = e.indexOf("'", i + 1); if (i < 0) break; continue; }
    if (e[i] === '(') nivel += 1;
    else if (e[i] === ')') nivel -= 1;
    else if (nivel === 0 && e.startsWith(sep, i)) { partes.push(e.slice(inicio, i)); inicio = i + sep.length; i += sep.length - 1; }
  }
  partes.push(e.slice(inicio));
  return partes.map(semParentesesExternos);
}

/** Verdadeiro se a expressão só deixa passar linhas da empresa do contexto (ou linhas sem empresa / ramos de vínculo). */
function restringeEmpresa(expr, tabela) {
  const e = semParentesesExternos(expr);
  if (RESTRICAO_EMPRESA.some((re) => re.test(e)) || LINHA_SEM_EMPRESA.test(e)) return true;
  const conjuncao = separar(e, 'AND');
  if (conjuncao.length > 1) return conjuncao.some((termo) => restringeEmpresa(termo, tabela));
  const disjuncao = separar(e, 'OR');
  if (disjuncao.length > 1) {
    return disjuncao.every((ramo) => restringeEmpresa(ramo, tabela) || (tabela === 'people.persons' && RAMOS_PESSOA.some((re) => re.test(ramo))));
  }
  return false;
}

async function politicasDeLeitura() {
  const [linhas] = await sequelize.query(`
    SELECT p.schemaname AS schema, p.tablename AS tabela, p.policyname AS politica, p.cmd, p.permissive, p.roles::text AS papeis, p.qual,
           EXISTS (SELECT 1 FROM information_schema.columns c WHERE c.table_schema = p.schemaname AND c.table_name = p.tablename AND c.column_name = 'company_id') AS tem_empresa
      FROM pg_policies p WHERE p.cmd IN ('ALL', 'SELECT') ORDER BY 1, 2, 3`);
  return linhas;
}

test('guarda: o analisador recusa os furos que o texto "company_id" deixava passar e aceita os padrões do sistema', () => {
  const ctx = "(NULLIF(current_setting('app.company_id'::text, true), ''::text))::uuid";
  const grupo = "(NULLIF(current_setting('app.group_id'::text, true), ''::text))::uuid";
  const recusa = [`((company_id IS NULL) OR (group_id = ${grupo}))`, '(company_id IS NOT NULL)', `((company_id = ${ctx}) OR (group_id = ${grupo}))`, `(group_id = ${grupo})`, 'true',
    `(company_id <> ${ctx})`, `((company_id = ${ctx}) OR true)`];
  const aceita = [`(company_id = ${ctx})`, `((group_id = ${grupo}) AND (company_id = ${ctx}))`, `((company_id = ${ctx}) OR ((company_id IS NULL) AND (group_id = ${grupo})))`,
    `((group_id = ${grupo}) AND ((company_id IS NULL) OR (company_id = ${ctx})))`, '((group_id IS NULL) AND (company_id IS NULL))'];
  for (const q of recusa) assert.equal(restringeEmpresa(q, 'x.y'), false, `deveria recusar: ${q}`);
  for (const q of aceita) assert.equal(restringeEmpresa(q, 'x.y'), true, `deveria aceitar: ${q}`);
});

test('RLS: toda política que libera SELECT numa tabela com company_id só deixa passar a empresa do contexto (fora as exceções listadas)', async () => {
  const linhas = (await politicasDeLeitura()).filter((l) => l.tem_empresa);
  assert.ok(linhas.length > 100, `catálogo inesperadamente pequeno (${linhas.length} políticas): o teste não estaria provando nada`);
  const abertas = linhas.filter((l) => l.permissive === 'PERMISSIVE' && !LOOKUPS_DELIBERADOS[`${l.schema}.${l.tabela}:${l.politica}`]
    && !restringeEmpresa(l.qual || 'true', `${l.schema}.${l.tabela}`));
  assert.deepEqual(abertas.map((l) => `${l.schema}.${l.tabela} ${l.politica} (${l.cmd}): ${l.qual}`), [],
    'política permissiva que vale para SELECT sem restringir à empresa do contexto (lembre: FOR ALL inclui SELECT e permissivas somam com OR)');
});

test('RLS: as exceções continuam com o predicado exato e a checagem do dono do vínculo não vale para nenhum papel da aplicação', async () => {
  const linhas = await politicasDeLeitura();
  for (const [chave, esperado] of Object.entries(LOOKUPS_DELIBERADOS)) {
    const [tab, pol] = chave.split(':');
    const linha = linhas.find((l) => `${l.schema}.${l.tabela}` === tab && l.politica === pol);
    assert.ok(linha, `exceção ${chave} sumiu do catálogo: retire-a da lista`);
    assert.equal(linha.cmd, 'SELECT', `${chave} tem de ser só SELECT`);
    assert.match(linha.qual, esperado, `${chave} mudou de predicado: ${linha.qual}`);
  }
  const dono = linhas.find((l) => l.politica === 'person_company_links_checagem_do_dono');
  const papeis = dono.papeis.replace(/[{}"]/g, '').split(',');
  assert.deepEqual(papeis.filter((p) => PAPEIS_DA_APLICACAO.includes(p)), [], `a checagem do dono vale para ${dono.papeis}`);
});

test('RLS: tabelas sem company_id com política de leitura formam uma lista fechada e nenhuma delas tem person_id', async () => {
  const linhas = (await politicasDeLeitura()).filter((l) => !l.tem_empresa && l.permissive === 'PERMISSIVE');
  assert.deepEqual(linhas.map((l) => `${l.schema}.${l.tabela}:${l.politica}`).sort(), Object.keys(SEM_EMPRESA).sort(), 'tabela nova sem company_id com leitura: revise o isolamento e inclua na lista');
  for (const l of linhas) assert.match(l.qual, SEM_EMPRESA[`${l.schema}.${l.tabela}:${l.politica}`], `${l.schema}.${l.tabela}:${l.politica} mudou: ${l.qual}`);
  const [comPessoa] = await sequelize.query(`SELECT c.table_schema || '.' || c.table_name AS t FROM information_schema.columns c
    WHERE c.column_name = 'person_id' AND c.table_schema NOT IN ('pg_catalog', 'information_schema')
      AND NOT EXISTS (SELECT 1 FROM information_schema.columns e WHERE e.table_schema = c.table_schema AND e.table_name = c.table_name AND e.column_name = 'company_id')`);
  assert.deepEqual(comPessoa.map((r) => r.t), [], 'tabela com person_id sem company_id escaparia do isolamento por empresa');
});

test('RLS: people.persons lê por empresa responsável OU vínculo ACTIVE OU prova; escreve só a responsável; nenhuma FOR ALL', async () => {
  const [linhas] = await sequelize.query(`
    SELECT policyname AS politica, cmd, qual, with_check FROM pg_policies WHERE schemaname = 'people' AND tablename = 'persons' ORDER BY 1`);
  assert.deepEqual(linhas.map((l) => `${l.politica}:${l.cmd}`), [
    'persons_company_delete:DELETE', 'persons_company_insert:INSERT', 'persons_company_select:SELECT', 'persons_company_update:UPDATE',
  ]);
  for (const l of linhas) {
    const termos = separar(l.qual || l.with_check, 'AND');
    assert.match(termos[0], new RegExp(`^group_id = ${CTX_GRUPO}$`), `${l.politica}: falta o grupo no primeiro termo`);
    if (l.cmd === 'SELECT') {
      const ramos = separar(termos[1], 'OR');
      assert.equal(ramos.length, 3, `persons_company_select: ramos inesperados ${termos[1]}`);
      assert.match(ramos[0], RESTRICAO_EMPRESA[1]);
      assert.match(ramos[1], RAMOS_PESSOA[0]);
      assert.match(ramos[2], RAMOS_PESSOA[1]);
    } else {
      for (const expr of [l.qual, l.with_check].filter(Boolean)) assert.deepEqual(separar(expr, 'AND').slice(1), [`company_scope_allows(company_id, ${'(NULLIF(current_setting(\'app.company_id\'::text, true), \'\'::text))::uuid'})`], `${l.politica}: escrita só da responsável`);
    }
  }
  const [[rls]] = await sequelize.query("SELECT relrowsecurity AS ena, relforcerowsecurity AS frc FROM pg_class WHERE oid = 'people.persons'::regclass");
  assert.deepEqual(rls, { ena: true, frc: true });
});

test('ISO-8: os cinco filhos de Pessoa têm chave composta validada para o vínculo e política RESTRICTIVE de vínculo ativo', async () => {
  const [fks] = await sequelize.query(`SELECT c.conrelid::regclass::text AS tabela, c.conname, c.convalidated, pg_get_constraintdef(c.oid) AS def
    FROM pg_constraint c WHERE c.contype = 'f' AND c.confrelid = 'people.person_company_links'::regclass ORDER BY 1`);
  assert.deepEqual(fks.map((f) => f.tabela).sort(), ['people.communication_consents', 'people.person_addresses', 'people.person_contacts', 'people.person_documents', 'people.person_roles']);
  for (const f of fks) {
    assert.equal(f.convalidated, true, `${f.conname} validada`);
    assert.match(f.def, /^FOREIGN KEY \(person_id, company_id\) REFERENCES people\.person_company_links\(person_id, company_id\)/);
  }
  const [restr] = await sequelize.query(`SELECT tablename AS tabela, cmd, with_check FROM pg_policies WHERE schemaname = 'people' AND permissive = 'RESTRICTIVE' ORDER BY 1, 2`);
  assert.equal(restr.length, 10, 'INSERT e UPDATE em cada um dos cinco filhos');
  for (const r of restr) assert.match(r.with_check, /l\.company_id = .*\.company_id\) AND \(\(l\.status\)::text = 'ACTIVE'::text\)/, `${r.tabela} ${r.cmd}`);
  const [pol] = await sequelize.query("SELECT cmd FROM pg_policies WHERE schemaname = 'people' AND tablename = 'person_company_links' ORDER BY 1");
  assert.ok(!pol.some((p) => ['ALL', 'DELETE'].includes(p.cmd)), 'vínculo não se apaga (sem política de DELETE nem FOR ALL)');
});

