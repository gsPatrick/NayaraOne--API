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
// (insurance_provider_submissions saiu da lista: tem RLS e FORCE RLS pela migration 646; o webhook público
//  da seguradora descobre a empresa pela função SECURITY DEFINER resolve_insurance_submission_routing.)
//   migrations/20260101000345-create-correspondent-external-case-routing.js
//     (correspondent.external_case_routing — webhook público de financiamento, Marco 8 Fase 6,
//     mesmo motivo; mapeamento mínimo só de IDs, nunca fonte de verdade de negócio)
// Qualquer outra tabela multiempresa fora desta lista precisa de RLS+FORCE RLS+policy — a
// lista existe para que uma exceção nova precise ser adicionada aqui EXPLICITAMENTE (code
// review visível), nunca passar silenciosamente.
const DELIBERATE_NO_RLS_EXCEPTIONS = new Set([
  'legal.signature_provider_routing',
  'finance.bank_payment_provider_routing',
  'crm.cart_share_routing',
  'correspondent.external_case_routing',
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

// M9-D600: as tabelas do núcleo de métricas do BI (schema analytics) precisam existir COM RLS + FORCE RLS
// e com as 4 políticas (leitura por empresa/grupo; escrita só do worker de BI).
test('M9-D600: analytics.metric_definitions, metric_versions e metric_snapshots têm RLS, FORCE RLS e 4 políticas', async () => {
  for (const table of ['metric_definitions', 'metric_versions', 'metric_snapshots']) {
    const [rows] = await sequelize.query(
      `SELECT c.relrowsecurity, c.relforcerowsecurity,
              (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid) AS policies
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'analytics' AND c.relname = :table`,
      { replacements: { table } }
    );
    assert.equal(rows.length, 1, `analytics.${table} não existe`);
    assert.equal(rows[0].relrowsecurity, true, `analytics.${table}: RLS`);
    assert.equal(rows[0].relforcerowsecurity, true, `analytics.${table}: FORCE RLS`);
    assert.equal(rows[0].policies, 4, `analytics.${table}: políticas`);
  }
});

// M9-D601: dashboards, widgets, briefings e exportações do BI (schema analytics) com RLS + FORCE RLS e 4 políticas.
test('M9-D601: analytics.dashboard_definitions, dashboard_widgets, executive_briefs e export_jobs têm RLS, FORCE RLS e 4 políticas', async () => {
  for (const table of ['dashboard_definitions', 'dashboard_widgets', 'executive_briefs', 'export_jobs']) {
    const [rows] = await sequelize.query(
      `SELECT c.relrowsecurity, c.relforcerowsecurity,
              (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid) AS policies
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'analytics' AND c.relname = :table`,
      { replacements: { table } }
    );
    assert.equal(rows.length, 1, `analytics.${table} não existe`);
    assert.equal(rows[0].relrowsecurity, true, `analytics.${table}: RLS`);
    assert.equal(rows[0].relforcerowsecurity, true, `analytics.${table}: FORCE RLS`);
    assert.equal(rows[0].policies, 4, `analytics.${table}: políticas`);
  }
});

// M9-D700: log de acesso do BI (analytics.access_log) com RLS + FORCE RLS e só as políticas de leitura e inserção (imutável).
test('M9-D700: analytics.access_log tem RLS, FORCE RLS e só as políticas de SELECT e INSERT', async () => {
  const [rows] = await sequelize.query(
    `SELECT c.relrowsecurity, c.relforcerowsecurity,
            (SELECT array_agg(p.polcmd::text ORDER BY p.polcmd::text) FROM pg_policy p WHERE p.polrelid = c.oid) AS cmds
     FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'analytics' AND c.relname = 'access_log'`
  );
  assert.equal(rows.length, 1, 'analytics.access_log não existe');
  assert.equal(rows[0].relrowsecurity, true, 'RLS');
  assert.equal(rows[0].relforcerowsecurity, true, 'FORCE RLS');
  assert.deepEqual(rows[0].cmds, ['a', 'r'], 'políticas: INSERT (a) e SELECT (r), nenhuma de UPDATE/DELETE');
});

// M9-D607: controle do worker de read models (eventos aplicados e agregados adiados) com RLS + FORCE RLS.
test('M9-D607: analytics.rm_applied_events (sem UPDATE) e rm_stale_aggregates têm RLS e FORCE RLS', async () => {
  const esperado = { rm_applied_events: ['a', 'd', 'r'], rm_stale_aggregates: ['a', 'd', 'r', 'w'] };
  for (const [table, cmds] of Object.entries(esperado)) {
    const [rows] = await sequelize.query(
      `SELECT c.relrowsecurity, c.relforcerowsecurity,
              (SELECT array_agg(p.polcmd::text ORDER BY p.polcmd::text) FROM pg_policy p WHERE p.polrelid = c.oid) AS cmds
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'analytics' AND c.relname = :table`,
      { replacements: { table } }
    );
    assert.equal(rows.length, 1, `analytics.${table} não existe`);
    assert.equal(rows[0].relrowsecurity, true, `analytics.${table}: RLS`);
    assert.equal(rows[0].relforcerowsecurity, true, `analytics.${table}: FORCE RLS`);
    assert.deepEqual(rows[0].cmds, cmds, `analytics.${table}: políticas`);
  }
});

// M9-D602: alertas, qualidade e diário de refresh do BI (schema analytics) com RLS + FORCE RLS e 4 políticas.
test('M9-D602: analytics.alert_definitions, alert_instances, data_quality_checks e read_model_refreshes têm RLS, FORCE RLS e 4 políticas', async () => {
  for (const table of ['alert_definitions', 'alert_instances', 'data_quality_checks', 'read_model_refreshes']) {
    const [rows] = await sequelize.query(
      `SELECT c.relrowsecurity, c.relforcerowsecurity,
              (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid) AS policies
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'analytics' AND c.relname = :table`,
      { replacements: { table } }
    );
    assert.equal(rows.length, 1, `analytics.${table} não existe`);
    assert.equal(rows[0].relrowsecurity, true, `analytics.${table}: RLS`);
    assert.equal(rows[0].relforcerowsecurity, true, `analytics.${table}: FORCE RLS`);
    assert.equal(rows[0].policies, 4, `analytics.${table}: políticas`);
  }
});

// M9-D207: erros de integração por empresa (RLS + FORCE, política de isolamento) e o contador agregado de webhook
// desconhecido (sem empresa: RLS + FORCE e só a marca de administração de plataforma enxerga).
test('M9-D207: integration.integration_errors e integration.platform_unknown_webhooks têm RLS e FORCE RLS', async () => {
  for (const [table, minPolicies] of [['integration_errors', 1], ['platform_unknown_webhooks', 1]]) {
    const [rows] = await sequelize.query(
      `SELECT c.relrowsecurity, c.relforcerowsecurity,
              (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid) AS policies
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'integration' AND c.relname = :table`,
      { replacements: { table } }
    );
    assert.equal(rows.length, 1, `integration.${table} não existe`);
    assert.equal(rows[0].relrowsecurity, true, `integration.${table}: RLS`);
    assert.equal(rows[0].relforcerowsecurity, true, `integration.${table}: FORCE RLS`);
    assert.ok(rows[0].policies >= minPolicies, `integration.${table}: política de isolamento`);
  }
});

// M9-D206: integration.provider_health (saúde por connection) com RLS, FORCE RLS, política tenant_isolation e função de expurgo.
test('M9-D206: integration.provider_health tem RLS, FORCE RLS, a política tenant_isolation e a função de expurgo SECURITY DEFINER', async () => {
  const [rows] = await sequelize.query(
    `SELECT c.relrowsecurity, c.relforcerowsecurity,
            (SELECT array_agg(p.polname::text) FROM pg_policy p WHERE p.polrelid = c.oid) AS policies
     FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'integration' AND c.relname = 'provider_health'`
  );
  assert.equal(rows.length, 1, 'integration.provider_health não existe');
  assert.equal(rows[0].relrowsecurity, true, 'RLS');
  assert.equal(rows[0].relforcerowsecurity, true, 'FORCE RLS');
  assert.deepEqual(rows[0].policies, ['tenant_isolation']);
  const [fn] = await sequelize.query(
    `SELECT p.prosecdef FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'integration' AND p.proname = 'purge_provider_health'`
  );
  assert.equal(fn.length, 1, 'integration.purge_provider_health não existe');
  assert.equal(fn[0].prosecdef, true, 'a função de expurgo precisa ser SECURITY DEFINER');
});

// M9-D203: integration.webhook_inbox (eventos externos idempotentes) com RLS, FORCE RLS, tenant_isolation e função de expurgo.
test('M9-D203: integration.webhook_inbox tem RLS, FORCE RLS, a política tenant_isolation e a função de retenção SECURITY DEFINER', async () => {
  const [rows] = await sequelize.query(
    `SELECT c.relrowsecurity, c.relforcerowsecurity,
            (SELECT array_agg(p.polname::text) FROM pg_policy p WHERE p.polrelid = c.oid) AS policies
     FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'integration' AND c.relname = 'webhook_inbox'`
  );
  assert.equal(rows.length, 1, 'integration.webhook_inbox não existe');
  assert.equal(rows[0].relrowsecurity, true, 'RLS');
  assert.equal(rows[0].relforcerowsecurity, true, 'FORCE RLS');
  assert.deepEqual(rows[0].policies, ['tenant_isolation']);
  const [fn] = await sequelize.query(
    `SELECT p.prosecdef FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'integration' AND p.proname = 'purge_webhook_inbox'`
  );
  assert.equal(fn.length, 1, 'integration.purge_webhook_inbox não existe');
  assert.equal(fn[0].prosecdef, true, 'a função de retenção precisa ser SECURITY DEFINER');
});

// M9-D205: integration.dispatches (intenção local de toda chamada externa) com RLS, FORCE RLS, tenant_isolation, gatilho de imutabilidade e função de retenção.
test('M9-D205: integration.dispatches tem RLS, FORCE RLS, a política tenant_isolation, o gatilho de imutabilidade e a função de retenção SECURITY DEFINER', async () => {
  const [rows] = await sequelize.query(
    `SELECT c.relrowsecurity, c.relforcerowsecurity,
            (SELECT array_agg(p.polname::text) FROM pg_policy p WHERE p.polrelid = c.oid) AS policies,
            (SELECT count(*)::int FROM pg_trigger g WHERE g.tgrelid = c.oid AND g.tgname = 'dispatches_immutable') AS gatilho
     FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'integration' AND c.relname = 'dispatches'`
  );
  assert.equal(rows.length, 1, 'integration.dispatches não existe');
  assert.equal(rows[0].relrowsecurity, true, 'RLS');
  assert.equal(rows[0].relforcerowsecurity, true, 'FORCE RLS');
  assert.deepEqual(rows[0].policies, ['tenant_isolation']);
  assert.equal(rows[0].gatilho, 1, 'gatilho de imutabilidade');
  const [fn] = await sequelize.query(
    `SELECT p.prosecdef FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'integration' AND p.proname = 'purge_dispatches'`
  );
  assert.equal(fn.length, 1, 'integration.purge_dispatches não existe');
  assert.equal(fn[0].prosecdef, true, 'a função de retenção precisa ser SECURITY DEFINER');
});

// M9-D014: ai.budgets (orçamento da NAY) e ai.budget_alerts (um alerta por limiar e período) com RLS, FORCE RLS e a política tenant_isolation.
test('M9-D014: ai.budgets e ai.budget_alerts têm RLS, FORCE RLS e a política tenant_isolation', async () => {
  for (const tabela of ['budgets', 'budget_alerts']) {
    const [rows] = await sequelize.query(
      `SELECT c.relrowsecurity, c.relforcerowsecurity,
              (SELECT array_agg(p.polname::text) FROM pg_policy p WHERE p.polrelid = c.oid) AS policies
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'ai' AND c.relname = :tabela`,
      { replacements: { tabela } }
    );
    assert.equal(rows.length, 1, `ai.${tabela} não existe`);
    assert.equal(rows[0].relrowsecurity, true, `RLS em ai.${tabela}`);
    assert.equal(rows[0].relforcerowsecurity, true, `FORCE RLS em ai.${tabela}`);
    assert.deepEqual(rows[0].policies, ['tenant_isolation']);
  }
});

// M9-D032: ai.evaluations, evaluation_items, feedback e golden_candidates (avaliação da NAY) com RLS, FORCE RLS, a política tenant_isolation e o gatilho de proteção.
test('M9-D032: ai.evaluations, ai.evaluation_items, ai.feedback e ai.golden_candidates têm RLS, FORCE RLS, tenant_isolation e gatilho de imutabilidade', async () => {
  const gatilhos = { evaluations: 'evaluations_guard', evaluation_items: 'evaluation_items_guard', feedback: null, golden_candidates: 'golden_candidates_guard' };
  for (const [tabela, gatilho] of Object.entries(gatilhos)) {
    const [rows] = await sequelize.query(
      `SELECT c.relrowsecurity, c.relforcerowsecurity,
              (SELECT array_agg(p.polname::text) FROM pg_policy p WHERE p.polrelid = c.oid) AS policies,
              (SELECT count(*)::int FROM pg_trigger g WHERE g.tgrelid = c.oid AND g.tgname = :gatilho) AS gatilho
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'ai' AND c.relname = :tabela`,
      { replacements: { tabela, gatilho: gatilho || '' } }
    );
    assert.equal(rows.length, 1, `ai.${tabela} não existe`);
    assert.equal(rows[0].relrowsecurity, true, `RLS em ai.${tabela}`);
    assert.equal(rows[0].relforcerowsecurity, true, `FORCE RLS em ai.${tabela}`);
    assert.deepEqual(rows[0].policies, ['tenant_isolation']);
    if (gatilho) assert.equal(rows[0].gatilho, 1, `gatilho ${gatilho}`);
  }
});
