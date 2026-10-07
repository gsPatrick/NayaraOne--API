'use strict';

// Item 7 do ciclo de auditoria externa (Marco 3 — Pessoas/CRM/Radar): a prova de RLS até aqui
// era por AMOSTRAGEM (ver M3-23 em marco3.acceptance.test.js, que só confere 3 tabelas).
// Contrato bruto (00000009-Contrato_Nayara_One_..._ANEXO_I...pdf):
//   "Todas as tabelas multiempresa têm RLS ENABLE + FORCE ROW LEVEL SECURITY." (linha ~3080)
//   "Políticas RLS serão deny-by-default. A inexistência de política equivale a acesso
//    negado." (linha ~1607)
//   "GATE-DB-02 — RLS multiempresa aprovada com suíte de testes adversariais." (linha ~3024)
//
// Este teste PERCORRE o catálogo real do Postgres (information_schema.columns) e, para TODA
// tabela de usuário que tenha uma coluna `company_id`, confere relrowsecurity=true E
// relforcerowsecurity=true, além de exigir ao menos uma pg_policy. Não há lista hard-coded de
// tabelas — se um módulo futuro criar uma tabela multiempresa sem RLS, esta suíte falha
// automaticamente, sem precisar que alguém lembre de atualizar um checklist manual.

const { test, after } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize } = require('./testHelpers');

after(async () => {
  await sequelize.close();
});

// Exceções DELIBERADAS e documentadas: tabelas de roteamento de webhook/link público (o
// provedor externo, OU o visitante anônimo de um link compartilhado, chama sem JWT/tenant
// conhecido de antemão — não há como aplicar SET LOCAL app.group_id/company_id ANTES de
// descobrir o tenant). Guardam só ids opacos + group_id/company_id, nunca conteúdo de
// negócio. Ver comentário completo em:
//   migrations/20260101000172-create-legal-signature_provider_routing.js
//   migrations/20260101000271-extend-payment-intents-for-bank-adapter.js (bank_payment_provider_routing)
//   migrations/20260101000286-create-crm-carts.js (cart_share_routing — link público do carrinho de imóveis)
// Qualquer outra tabela multiempresa fora desta lista precisa de RLS+FORCE RLS+policy — a
// lista existe para que uma exceção nova precise ser adicionada aqui EXPLICITAMENTE (code
// review visível), nunca passar silenciosamente.
const DELIBERATE_NO_RLS_EXCEPTIONS = new Set([
  'legal.signature_provider_routing',
  'finance.bank_payment_provider_routing',
  'crm.cart_share_routing',
]);

test('RLS/FORCE RLS habilitados em 100% das tabelas multiempresa (coluna company_id) do catálogo Postgres', async () => {
  const [multiCompanyTables] = await sequelize.query(`
    SELECT DISTINCT c.table_schema AS schema, c.table_name AS table
    FROM information_schema.columns c
    JOIN information_schema.tables t
      ON t.table_schema = c.table_schema AND t.table_name = c.table_name AND t.table_type = 'BASE TABLE'
    WHERE c.column_name = 'company_id'
      AND c.table_schema NOT IN ('pg_catalog', 'information_schema')
    ORDER BY 1, 2
  `);

  assert.ok(
    multiCompanyTables.length > 10,
    'sanity check: catálogo deveria listar bem mais que 10 tabelas multiempresa — algo errou na query/conexão'
  );

  const offenders = [];

  for (const { schema, table } of multiCompanyTables) {
    if (DELIBERATE_NO_RLS_EXCEPTIONS.has(`${schema}.${table}`)) continue;
    // eslint-disable-next-line no-await-in-loop
    const [rows] = await sequelize.query(
      `SELECT relrowsecurity, relforcerowsecurity
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = :schema AND c.relname = :table`,
      { replacements: { schema, table } }
    );

    if (rows.length !== 1) {
      offenders.push(`${schema}.${table}: tabela não encontrada em pg_class (${rows.length} linhas)`);
      continue;
    }

    const { relrowsecurity, relforcerowsecurity } = rows[0];
    if (relrowsecurity !== true) {
      offenders.push(`${schema}.${table}: RLS (relrowsecurity) NÃO está habilitado`);
    }
    if (relforcerowsecurity !== true) {
      offenders.push(`${schema}.${table}: FORCE RLS (relforcerowsecurity) NÃO está habilitado`);
    }

    // eslint-disable-next-line no-await-in-loop
    const [policies] = await sequelize.query(
      `SELECT polname FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = :schema AND c.relname = :table`,
      { replacements: { schema, table } }
    );
    if (policies.length < 1) {
      offenders.push(`${schema}.${table}: nenhuma pg_policy de isolamento encontrada (deny-by-default exige ao menos 1)`);
    }
  }

  const seenExceptions = multiCompanyTables
    .map(({ schema, table }) => `${schema}.${table}`)
    .filter((key) => DELIBERATE_NO_RLS_EXCEPTIONS.has(key));
  assert.deepEqual(
    new Set(seenExceptions),
    DELIBERATE_NO_RLS_EXCEPTIONS,
    'a lista de exceções deliberadas (webhook routing) deve bater exatamente com o catálogo — se sobrou uma exceção que não existe mais, ou apareceu uma tabela nova sem RLS não revisada, isso precisa ser investigado explicitamente'
  );

  assert.equal(
    offenders.length,
    0,
    `${offenders.length} tabela(s) multiempresa sem RLS/FORCE RLS/policy completos (percorridas ${multiCompanyTables.length} tabelas):\n` +
      offenders.join('\n')
  );
});
