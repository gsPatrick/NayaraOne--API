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

// M9-D015: ai.cache_entries (cache seguro da NAY) com RLS, FORCE RLS e a política tenant_isolation.
test('M9-D015: ai.cache_entries tem RLS, FORCE RLS e a política tenant_isolation', async () => {
  const [rows] = await sequelize.query(
    `SELECT c.relrowsecurity, c.relforcerowsecurity, (SELECT array_agg(p.polname::text) FROM pg_policy p WHERE p.polrelid = c.oid) AS policies
     FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'ai' AND c.relname = 'cache_entries'`
  );
  assert.equal(rows.length, 1, 'ai.cache_entries não existe');
  assert.equal(rows[0].relrowsecurity, true, 'RLS em ai.cache_entries');
  assert.equal(rows[0].relforcerowsecurity, true, 'FORCE RLS em ai.cache_entries');
  assert.deepEqual(rows[0].policies, ['tenant_isolation']);
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

// M9-D033: ai.golden_cases (golden dataset por agente) com RLS, FORCE RLS, tenant_isolation, leitura do padrão do sistema e o gatilho de imutabilidade.
test('M9-D033: ai.golden_cases tem RLS, FORCE RLS, tenant_isolation, system_default_read e o gatilho de imutabilidade', async () => {
  const [rows] = await sequelize.query(
    `SELECT c.relrowsecurity, c.relforcerowsecurity,
            (SELECT array_agg(p.polname::text ORDER BY p.polname) FROM pg_policy p WHERE p.polrelid = c.oid) AS policies,
            (SELECT count(*)::int FROM pg_trigger g WHERE g.tgrelid = c.oid AND g.tgname = 'golden_cases_guard') AS gatilho
     FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'ai' AND c.relname = 'golden_cases'`
  );
  assert.equal(rows.length, 1, 'ai.golden_cases não existe');
  assert.equal(rows[0].relrowsecurity, true, 'RLS em ai.golden_cases');
  assert.equal(rows[0].relforcerowsecurity, true, 'FORCE RLS em ai.golden_cases');
  assert.deepEqual(rows[0].policies, ['system_default_read', 'tenant_isolation']);
  assert.equal(rows[0].gatilho, 1, 'gatilho golden_cases_guard');
});

// M9-D009: ai.memories (memória estruturada da NAY) com RLS, FORCE RLS, a política tenant_isolation e os gatilhos que impedem apagar.
test('M9-D009: ai.memories tem RLS, FORCE RLS, tenant_isolation e os gatilhos de não apagar e de conteúdo imutável', async () => {
  const [rows] = await sequelize.query(
    `SELECT c.relrowsecurity, c.relforcerowsecurity,
            (SELECT array_agg(p.polname::text) FROM pg_policy p WHERE p.polrelid = c.oid) AS policies,
            (SELECT array_agg(g.tgname::text ORDER BY g.tgname) FROM pg_trigger g WHERE g.tgrelid = c.oid AND NOT g.tgisinternal) AS gatilhos
     FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'ai' AND c.relname = 'memories'`
  );
  assert.equal(rows.length, 1, 'ai.memories não existe');
  assert.equal(rows[0].relrowsecurity, true, 'RLS em ai.memories');
  assert.equal(rows[0].relforcerowsecurity, true, 'FORCE RLS em ai.memories');
  assert.deepEqual(rows[0].policies, ['tenant_isolation']);
  assert.deepEqual(rows[0].gatilhos, ['memories_guard', 'memories_no_truncate']);
});

// M9-D625: analytics.rm_finance_intercompany (transferências entre empresas para o consolidado do grupo) tem RLS, FORCE RLS e 4 políticas.
test('M9-D625: analytics.rm_finance_intercompany tem RLS, FORCE RLS e 4 políticas', async () => {
  const [rows] = await sequelize.query(
    `SELECT c.relrowsecurity, c.relforcerowsecurity,
            (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid) AS policies
     FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'analytics' AND c.relname = 'rm_finance_intercompany'`
  );
  assert.equal(rows.length, 1, 'analytics.rm_finance_intercompany existe');
  assert.equal(rows[0].relrowsecurity, true);
  assert.equal(rows[0].relforcerowsecurity, true);
  assert.equal(rows[0].policies, 4);
});

// M9-D615: read models do Financeiro no BI (saúde por empresa e margem por setor) com RLS + FORCE RLS e 4 políticas.
test('M9-D615: analytics.rm_finance_health e rm_finance_sector_margin têm RLS, FORCE RLS e 4 políticas', async () => {
  for (const table of ['rm_finance_health', 'rm_finance_sector_margin']) {
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

// M9-D627: read models de Marketing e Atendimento/Satisfação no BI com RLS + FORCE RLS e 4 políticas.
test('M9-D627: os 8 read models de Marketing e Atendimento têm RLS, FORCE RLS e 4 políticas', async () => {
  for (const table of ['rm_mkt_campaigns', 'rm_mkt_delivery', 'rm_mkt_frequency', 'rm_mkt_reviews', 'rm_mkt_automation', 'rm_support_satisfaction', 'rm_support_complaints', 'rm_support_sla']) {
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

// M9-D670 / M9-D671: read models mensais de Marketing no BI (campanha e mês; contatos e pedidos de saída) com RLS + FORCE RLS, 4 políticas e escrita só do worker.
test('M9-D670/M9-D671: rm_mkt_campaign_month e rm_mkt_optout_month têm RLS, FORCE RLS e 4 políticas', async () => {
  for (const table of ['rm_mkt_campaign_month', 'rm_mkt_optout_month']) {
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

// M9-D618: read models de Obras, Estoque/Patrimônio e Pós-obra no BI com RLS + FORCE RLS e 4 políticas.
test('M9-D618: os 9 read models de Obras, Estoque e Pós-obra têm RLS, FORCE RLS e 4 políticas', async () => {
  const tables = ['rm_project_progress', 'rm_project_cost', 'rm_project_delays', 'rm_project_measurements', 'rm_project_nonconformities', 'rm_project_waste', 'rm_postwork_cost', 'rm_inventory_health', 'rm_tool_assets'];
  const [rows] = await sequelize.query(`SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity, (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid) AS policies
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'analytics' AND c.relname IN (:tables) ORDER BY 1`, { replacements: { tables } });
  assert.equal(rows.length, tables.length, 'as nove tabelas existem');
  for (const r of rows) assert.deepEqual([r.relrowsecurity, r.relforcerowsecurity, r.policies], [true, true, 4], `analytics.${r.relname}`);
});

// M9-D616 e M9-D617: read models de Comercial/CRM e Imóveis (9) e de Locação (9) no BI com RLS + FORCE RLS e 4 políticas.
test('M9-D616: os 9 read models de Comercial/CRM e Imóveis têm RLS, FORCE RLS e 4 políticas', async () => {
  const tables = ['rm_crm_lead_daily', 'rm_crm_opportunity_stage', 'rm_crm_outcome', 'rm_crm_next_action', 'rm_crm_visits_proposals', 'rm_property_portfolio', 'rm_property_price_changes', 'rm_radar_matches', 'rm_broker_performance'];
  const [rows] = await sequelize.query(`SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity, (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid) AS policies
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'analytics' AND c.relname IN (:tables) ORDER BY 1`, { replacements: { tables } });
  assert.equal(rows.length, tables.length, 'as nove tabelas existem');
  for (const r of rows) assert.deepEqual([r.relrowsecurity, r.relforcerowsecurity, r.policies], [true, true, 4], `analytics.${r.relname}`);
});

test('M9-D617: os 9 read models de Locação têm RLS, FORCE RLS e 4 políticas', async () => {
  const tables = ['rm_rental_contracts', 'rm_rental_vacancy', 'rm_rental_arrears', 'rm_rental_guarantees', 'rm_rental_obligations', 'rm_rental_inspections_keys', 'rm_rental_tickets', 'rm_rental_satisfaction', 'rm_rental_repasses'];
  const [rows] = await sequelize.query(`SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity, (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid) AS policies
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'analytics' AND c.relname IN (:tables) ORDER BY 1`, { replacements: { tables } });
  assert.equal(rows.length, tables.length, 'as nove tabelas existem');
  for (const r of rows) assert.deepEqual([r.relrowsecurity, r.relforcerowsecurity, r.policies], [true, true, 4], `analytics.${r.relname}`);
});

// M9-D802: tabela nova do bloco de governança com RLS + FORCE RLS e a política de isolamento por empresa.
test('M9-D802: calendar_alert_log tem RLS, FORCE RLS e a política tenant_isolation', async () => {
  const tables = ['calendar_alert_log'];
  const [rows] = await sequelize.query(`SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity,
      (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid AND p.polname = 'tenant_isolation') AS policies
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'governance' AND c.relname IN (:tables) ORDER BY 1`, { replacements: { tables } });
  assert.equal(rows.length, tables.length, 'a tabela existe');
  for (const r of rows) assert.deepEqual([r.relrowsecurity, r.relforcerowsecurity, r.policies], [true, true, 1], `governance.${r.relname}`);
});

// M9-D619: read models de Jurídico e Correspondente Bancário no BI com RLS + FORCE RLS e 4 políticas.
test('M9-D619: os 7 read models de Jurídico e Correspondente têm RLS, FORCE RLS e 4 políticas', async () => {
  const tables = ['rm_legal_deadlines', 'rm_legal_cases_risk', 'rm_legal_values', 'rm_legal_missing_docs', 'rm_fin_cases_stage', 'rm_fin_provider_outcome', 'rm_fin_commission'];
  const [rows] = await sequelize.query(`SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity, (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid) AS policies
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'analytics' AND c.relname IN (:tables) ORDER BY 1`, { replacements: { tables } });
  assert.equal(rows.length, tables.length, 'as sete tabelas existem');
  for (const r of rows) assert.deepEqual([r.relrowsecurity, r.relforcerowsecurity, r.policies], [true, true, 4], `analytics.${r.relname}`);
});

// M9-D804: domínios de dados e designações de owner/steward com RLS + FORCE RLS e a política tenant_isolation.
test('M9-D804: data_domains e data_domain_assignments têm RLS, FORCE RLS e a política tenant_isolation', async () => {
  const tables = ['data_domain_assignments', 'data_domains'];
  const [rows] = await sequelize.query(`SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity,
      (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid AND p.polname = 'tenant_isolation') AS policies
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'governance' AND c.relname IN (:tables) ORDER BY 1`, { replacements: { tables } });
  assert.equal(rows.length, tables.length, 'as duas tabelas existem');
  for (const r of rows) assert.deepEqual([r.relrowsecurity, r.relforcerowsecurity, r.policies], [true, true, 1], `governance.${r.relname}`);
});


// M9-D224: integration.alerts (alertas operacionais das integrações) com RLS + FORCE RLS, a política tenant_isolation e sem DELETE para o runtime.
test('M9-D224: integration.alerts tem RLS, FORCE RLS, a política tenant_isolation e o índice único dos abertos', async () => {
  const [rows] = await sequelize.query(`SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity,
      (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid AND p.polname = 'tenant_isolation') AS policies,
      (SELECT count(*)::int FROM pg_indexes i WHERE i.schemaname = 'integration' AND i.tablename = 'alerts' AND i.indexname = 'alerts_open_unique') AS indice
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'integration' AND c.relname = 'alerts'`);
  assert.equal(rows.length, 1, 'a tabela existe');
  assert.deepEqual([rows[0].relrowsecurity, rows[0].relforcerowsecurity, rows[0].policies, rows[0].indice], [true, true, 1, 1]);
});

// M9-D214: integration.dispatch_attempts (uma linha por tentativa de chamada a fornecedor) com RLS + FORCE RLS e a política tenant_isolation.
test('M9-D214: integration.dispatch_attempts tem RLS, FORCE RLS e a política tenant_isolation', async () => {
  const [rows] = await sequelize.query(`SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity,
      (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid AND p.polname = 'tenant_isolation') AS policies
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'integration' AND c.relname = 'dispatch_attempts'`);
  assert.equal(rows.length, 1, 'a tabela existe');
  assert.deepEqual([rows[0].relrowsecurity, rows[0].relforcerowsecurity, rows[0].policies], [true, true, 1]);
});

// M9-D022/D023: ai.ingestions e ai.chunks (RAG da NAY) com RLS, FORCE RLS, a política tenant_isolation e os gatilhos que impedem apagar.
test('M9-D022/D023: ai.ingestions e ai.chunks têm RLS, FORCE RLS, tenant_isolation e gatilho de não apagar', async () => {
  const gatilhos = { ingestions: 'ingestions_guard', chunks: 'chunks_guard' };
  for (const [tabela, gatilho] of Object.entries(gatilhos)) {
    const [rows] = await sequelize.query(
      `SELECT c.relrowsecurity, c.relforcerowsecurity,
              (SELECT array_agg(p.polname::text) FROM pg_policy p WHERE p.polrelid = c.oid) AS policies,
              (SELECT count(*)::int FROM pg_trigger g WHERE g.tgrelid = c.oid AND g.tgname = :gatilho) AS gatilho
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'ai' AND c.relname = :tabela`,
      { replacements: { tabela, gatilho } }
    );
    assert.equal(rows.length, 1, `ai.${tabela} não existe`);
    assert.deepEqual([rows[0].relrowsecurity, rows[0].relforcerowsecurity, rows[0].policies, rows[0].gatilho], [true, true, ['tenant_isolation'], 1], `ai.${tabela}`);
  }
});

// M9-D807: governance.field_change_evidence (origem e comprovante de alteração de campo crítico) com RLS + FORCE RLS e a política tenant_isolation.
test('M9-D807: field_change_evidence tem RLS, FORCE RLS e a política tenant_isolation', async () => {
  const [rows] = await sequelize.query(`SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity,
      (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid AND p.polname = 'tenant_isolation') AS policies
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'governance' AND c.relname = 'field_change_evidence'`);
  assert.equal(rows.length, 1, 'a tabela existe');
  assert.deepEqual([rows[0].relrowsecurity, rows[0].relforcerowsecurity, rows[0].policies], [true, true, 1]);
});

// M9-D609: analytics.snapshot_job_runs (diário do snapshot diário do BI) com RLS, FORCE RLS e as 4 políticas.
test('M9-D609: snapshot_job_runs tem RLS, FORCE RLS e 4 políticas', async () => {
  const [rows] = await sequelize.query(`SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity, (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid) AS policies
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'analytics' AND c.relname = 'snapshot_job_runs'`);
  assert.equal(rows.length, 1, 'a tabela existe');
  assert.deepEqual([rows[0].relrowsecurity, rows[0].relforcerowsecurity, rows[0].policies], [true, true, 4]);
});

// M9-D708: analytics.metric_acceptance (reconciliação e aceite dos KPIs pelo owner) com RLS, FORCE RLS e 3 políticas (leitura, inclusão e atualização; sem DELETE).
test('M9-D708: metric_acceptance tem RLS, FORCE RLS e 3 políticas (sem DELETE)', async () => {
  const [rows] = await sequelize.query(`SELECT c.relrowsecurity, c.relforcerowsecurity, (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid) AS policies
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'analytics' AND c.relname = 'metric_acceptance'`);
  assert.equal(rows.length, 1, 'a tabela existe');
  assert.deepEqual([rows[0].relrowsecurity, rows[0].relforcerowsecurity, rows[0].policies], [true, true, 3]);
});

// M9-D805: governance.review_queue_items (fila de merge e review de Person, Property e Supplier) com RLS + FORCE RLS e a política tenant_isolation.
test('M9-D805: review_queue_items tem RLS, FORCE RLS e a política tenant_isolation', async () => {
  const [rows] = await sequelize.query(`SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity,
      (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid AND p.polname = 'tenant_isolation') AS policies
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'governance' AND c.relname = 'review_queue_items'`);
  assert.equal(rows.length, 1, 'a tabela existe');
  assert.deepEqual([rows[0].relrowsecurity, rows[0].relforcerowsecurity, rows[0].policies], [true, true, 1]);
});

// M9-D806: governance.quality_rules, quality_scores e quality_issues (qualidade de cadastro) com RLS + FORCE RLS e a política tenant_isolation.
test('M9-D806: quality_rules, quality_scores e quality_issues têm RLS, FORCE RLS e a política tenant_isolation', async () => {
  const tables = ['quality_rules', 'quality_scores', 'quality_issues'];
  const [rows] = await sequelize.query(`SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity,
      (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid AND p.polname = 'tenant_isolation') AS policies
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'governance' AND c.relname IN (:tables) ORDER BY 1`, { replacements: { tables } });
  assert.equal(rows.length, tables.length, 'as três tabelas existem');
  for (const r of rows) assert.deepEqual([r.relrowsecurity, r.relforcerowsecurity, r.policies], [true, true, 1], `governance.${r.relname}`);
});

// M9-D808: governance.bulk_changes e bulk_change_items (alteração em massa de dados mestres) com RLS + FORCE RLS e a política tenant_isolation.
test('M9-D808: bulk_changes e bulk_change_items têm RLS, FORCE RLS e a política tenant_isolation', async () => {
  const tables = ['bulk_changes', 'bulk_change_items'];
  const [rows] = await sequelize.query(`SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity,
      (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid AND p.polname = 'tenant_isolation') AS policies
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'governance' AND c.relname IN (:tables) ORDER BY 1`, { replacements: { tables } });
  assert.equal(rows.length, tables.length, 'as duas tabelas existem');
  for (const r of rows) assert.deepEqual([r.relrowsecurity, r.relforcerowsecurity, r.policies], [true, true, 1], `governance.${r.relname}`);
});

// M9-D911: retention_policies, retention_runs, retention_run_items e retention_archives (retenção de dados) com RLS, FORCE RLS e a política tenant_isolation.
test('M9-D911: as tabelas de retenção têm RLS, FORCE RLS e a política tenant_isolation', async () => {
  const tables = ['retention_archives', 'retention_policies', 'retention_run_items', 'retention_runs'];
  const [rows] = await sequelize.query(`SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity,
      (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid AND p.polname = 'tenant_isolation') AS policies
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'governance' AND c.relname IN (:tables) ORDER BY 1`, { replacements: { tables } });
  assert.equal(rows.length, tables.length, 'as quatro tabelas existem');
  for (const r of rows) assert.deepEqual([r.relrowsecurity, r.relforcerowsecurity, r.policies], [true, true, 1], `governance.${r.relname}`);
});

// M9-D910: o registro de classificação e a lista de revisão do vocabulário antigo com RLS, FORCE RLS e a política tenant_isolation.
test('M9-D910: data_classification_registry e classification_review_items têm RLS, FORCE RLS e a política tenant_isolation', async () => {
  const tables = ['classification_review_items', 'data_classification_registry'];
  const [rows] = await sequelize.query(`SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity,
      (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid AND p.polname = 'tenant_isolation') AS policies
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'governance' AND c.relname IN (:tables) ORDER BY 1`, { replacements: { tables } });
  assert.equal(rows.length, tables.length, 'as duas tabelas existem');
  for (const r of rows) assert.deepEqual([r.relrowsecurity, r.relforcerowsecurity, r.policies], [true, true, 1], `governance.${r.relname}`);
});

// M9-D652: read model das ocorrências de obra (recorrência) com RLS + FORCE RLS e 4 políticas.
test('M9-D652: rm_project_occurrences tem RLS, FORCE RLS e 4 políticas', async () => {
  const [rows] = await sequelize.query(`SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity, (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid) AS policies
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'analytics' AND c.relname = 'rm_project_occurrences'`);
  assert.equal(rows.length, 1, 'a tabela existe');
  assert.deepEqual([rows[0].relrowsecurity, rows[0].relforcerowsecurity, rows[0].policies], [true, true, 4]);
});

// M9-D628: read models de Tecnologia e IA do BI com RLS + FORCE RLS e 4 políticas; o registro de sinais técnicos globais (sem company_id) com RLS + FORCE RLS e só o escritor do BI.
test('M9-D628: rm_tech_* e rm_ai_* têm RLS, FORCE RLS e 4 políticas; tech_signal_log tem RLS, FORCE RLS e 3 políticas', async () => {
  const tables = ['rm_tech_availability', 'rm_tech_queues', 'rm_tech_freshness', 'rm_tech_integrations', 'rm_tech_blocked_events', 'rm_tech_auth_failures', 'rm_ai_cost', 'rm_ai_quality', 'rm_ai_tool_calls', 'tech_signal_log'];
  const [rows] = await sequelize.query(`SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity, (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid) AS policies
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'analytics' AND c.relname IN (:tables) ORDER BY 1`, { replacements: { tables } });
  assert.equal(rows.length, tables.length, 'as dez tabelas existem');
  for (const r of rows) assert.deepEqual([r.relrowsecurity, r.relforcerowsecurity, r.policies], [true, true, r.relname === 'tech_signal_log' ? 3 : 4], r.relname);
});

// M9-D709: read model da fila de decisão do Centro de Comando com RLS + FORCE RLS e 4 políticas.
test('M9-D709: rm_decision_queue tem RLS, FORCE RLS e 4 políticas', async () => {
  const [rows] = await sequelize.query(`SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity, (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid) AS policies
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'analytics' AND c.relname = 'rm_decision_queue'`);
  assert.equal(rows.length, 1, 'a tabela existe');
  assert.deepEqual([rows[0].relrowsecurity, rows[0].relforcerowsecurity, rows[0].policies], [true, true, 4]);
});

// M9-D710: fatos do dia do Centro de Comando (contrato assinado, oportunidade ganha, pagamento liquidado) com RLS + FORCE RLS, 4 políticas e escrita só do worker.
test('M9-D710: rm_command_events tem RLS, FORCE RLS e 4 políticas', async () => {
  const [rows] = await sequelize.query(`SELECT c.relrowsecurity, c.relforcerowsecurity, (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid) AS policies
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'analytics' AND c.relname = 'rm_command_events'`);
  assert.equal(rows.length, 1, 'a tabela existe');
  assert.deepEqual([rows[0].relrowsecurity, rows[0].relforcerowsecurity, rows[0].policies], [true, true, 4]);
});

// M9-D810: o registro de lineage (nós, arestas e estado da semente) é do GRUPO: RLS + FORCE RLS e a política tenant_isolation por group_id.
test('M9-D810: lineage_nodes, lineage_edges e lineage_seed_state têm RLS, FORCE RLS e a política tenant_isolation por grupo', async () => {
  const tables = ['lineage_nodes', 'lineage_edges', 'lineage_seed_state'];
  const [rows] = await sequelize.query(`SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity,
      (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid AND p.polname = 'tenant_isolation' AND pg_get_expr(p.polqual, p.polrelid) LIKE '%app.group_id%') AS policies
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'governance' AND c.relname IN (:tables) ORDER BY 1`, { replacements: { tables } });
  assert.equal(rows.length, tables.length, 'as três tabelas existem');
  for (const r of rows) assert.deepEqual([r.relrowsecurity, r.relforcerowsecurity, r.policies], [true, true, 1], `governance.${r.relname}`);
});

// M9-D820: a política de DLP (governance.dlp_policies) é da EMPRESA: RLS + FORCE RLS e a política tenant_isolation por company_id.
test('M9-D820: dlp_policies tem RLS, FORCE RLS e a política tenant_isolation por empresa', async () => {
  const tables = ['dlp_policies'];
  const [rows] = await sequelize.query(`SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity,
      (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid AND p.polname = 'tenant_isolation' AND pg_get_expr(p.polqual, p.polrelid) LIKE '%app.company_id%') AS policies
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'governance' AND c.relname IN (:tables) ORDER BY 1`, { replacements: { tables } });
  assert.equal(rows.length, tables.length, 'a tabela existe');
  for (const r of rows) assert.deepEqual([r.relrowsecurity, r.relforcerowsecurity, r.policies], [true, true, 1], `governance.${r.relname}`);
});

// M9-D821: os pedidos de exportação/compartilhamento/impressão decididos pelo guard de DLP (governance.export_jobs) são da EMPRESA: RLS + FORCE RLS e tenant_isolation.
test('M9-D821: export_jobs tem RLS, FORCE RLS e a política tenant_isolation por empresa', async () => {
  const tables = ['export_jobs'];
  const [rows] = await sequelize.query(`SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity,
      (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid AND p.polname = 'tenant_isolation' AND pg_get_expr(p.polqual, p.polrelid) LIKE '%app.company_id%') AS policies
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'governance' AND c.relname IN (:tables) ORDER BY 1`, { replacements: { tables } });
  assert.equal(rows.length, tables.length, 'a tabela existe');
  for (const r of rows) assert.deepEqual([r.relrowsecurity, r.relforcerowsecurity, r.policies], [true, true, 1], `governance.${r.relname}`);
  const [grants] = await sequelize.query("SELECT has_table_privilege('nayara_runtime', 'governance.export_jobs', 'INSERT') AS ins WHERE EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nayara_runtime')");
  if (grants.length) assert.equal(grants[0].ins, true, 'GRANT ao role de runtime');
});

// M9-D824: sinais de acesso, anomalias de acesso em massa e o estado de DLP do usuário (governance.*) são da EMPRESA: RLS + FORCE RLS, tenant_isolation e GRANT.
test('M9-D824: access_signals, access_anomalies e user_dlp_state têm RLS, FORCE RLS e a política tenant_isolation por empresa', async () => {
  const tables = ['access_anomalies', 'access_signals', 'user_dlp_state'];
  const [rows] = await sequelize.query(`SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity,
      (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid AND p.polname = 'tenant_isolation' AND pg_get_expr(p.polqual, p.polrelid) LIKE '%app.company_id%') AS policies
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'governance' AND c.relname IN (:tables) ORDER BY 1`, { replacements: { tables } });
  assert.equal(rows.length, tables.length, 'as três tabelas existem');
  for (const r of rows) assert.deepEqual([r.relrowsecurity, r.relforcerowsecurity, r.policies], [true, true, 1], `governance.${r.relname}`);
  for (const table of tables) {
    const [grants] = await sequelize.query(`SELECT has_table_privilege('nayara_runtime', 'governance.${table}', 'INSERT') AS ins WHERE EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nayara_runtime')`);
    if (grants.length) assert.equal(grants[0].ins, true, `GRANT ao role de runtime em ${table}`);
  }
});

// M9-D823: os links externos (governance.share_links) são da EMPRESA: RLS + FORCE RLS, a política tenant_isolation e a de leitura por token (só a linha do hash da transação); o contador
// de acessos públicos (governance.public_access_counters) não tem empresa (visitante anônimo): RLS + FORCE RLS com a política que só abre para o limitador. GRANT ao role de runtime.
test('M9-D823: share_links e public_access_counters têm RLS, FORCE RLS e as políticas esperadas', async () => {
  const [rows] = await sequelize.query(`SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity, (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid) AS policies,
      (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid AND p.polname IN ('tenant_isolation', 'share_token_lookup', 'public_counter_writer')) AS named
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'governance' AND c.relname IN ('share_links', 'public_access_counters') ORDER BY 1`);
  assert.equal(rows.length, 2, 'as duas tabelas existem');
  assert.deepEqual(rows.map((r) => [r.relname, r.relrowsecurity, r.relforcerowsecurity, r.policies, r.named]), [['public_access_counters', true, true, 1, 1], ['share_links', true, true, 2, 2]]);
  for (const table of ['share_links', 'public_access_counters']) {
    const [grants] = await sequelize.query(`SELECT has_table_privilege('nayara_runtime', 'governance.${table}', 'INSERT') AS ins WHERE EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nayara_runtime')`);
    if (grants.length) assert.equal(grants[0].ins, true, `GRANT ao role de runtime em ${table}`);
  }
});

// M9-D832: a importação das operações manuais (governance.manual_operation_imports) e a conferência (governance.reconciliations) são da EMPRESA: RLS + FORCE RLS, tenant_isolation e GRANT.
test('M9-D832: manual_operation_imports e reconciliations têm RLS, FORCE RLS e a política tenant_isolation por empresa', async () => {
  const tables = ['manual_operation_imports', 'reconciliations'];
  const [rows] = await sequelize.query(`SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity,
      (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid AND p.polname = 'tenant_isolation' AND pg_get_expr(p.polqual, p.polrelid) LIKE '%app.company_id%') AS policies
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'governance' AND c.relname IN (:tables) ORDER BY 1`, { replacements: { tables } });
  assert.equal(rows.length, tables.length, 'as duas tabelas existem');
  for (const r of rows) assert.deepEqual([r.relrowsecurity, r.relforcerowsecurity, r.policies], [true, true, 1], `governance.${r.relname}`);
  for (const table of tables) {
    const [grants] = await sequelize.query(`SELECT has_table_privilege('nayara_runtime', 'governance.${table}', 'INSERT') AS ins WHERE EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nayara_runtime')`);
    if (grants.length) assert.equal(grants[0].ins, true, `GRANT ao role de runtime em ${table}`);
  }
});

// M9-D834: o modelo dos 11 formulários contingenciais (governance.bcp_form_templates) é catálogo do sistema, só leitura: RLS + FORCE RLS, a política de leitura e SELECT ao role de runtime.
test('M9-D834: bcp_form_templates tem RLS, FORCE RLS e a política de leitura', async () => {
  const [rows] = await sequelize.query(`SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity, (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid) AS policies,
      (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid AND p.polname = 'bcp_form_templates_read') AS named
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'governance' AND c.relname = 'bcp_form_templates'`);
  assert.deepEqual(rows.map((r) => [r.relname, r.relrowsecurity, r.relforcerowsecurity, r.policies, r.named]), [['bcp_form_templates', true, true, 1, 1]]);
  const [grants] = await sequelize.query("SELECT has_table_privilege('nayara_runtime', 'governance.bcp_form_templates', 'SELECT') AS sel WHERE EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nayara_runtime')");
  if (grants.length) assert.equal(grants[0].sel, true, 'SELECT ao role de runtime');
});

// M9-D830: o catálogo de setores do BCP (governance.bcp_sectors) é igual para toda empresa (só leitura): RLS + FORCE RLS, a política de leitura e SELECT ao role de runtime.
test('M9-D830: bcp_sectors tem RLS, FORCE RLS e a política de leitura', async () => {
  const [rows] = await sequelize.query(`SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity, (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid) AS policies,
      (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid AND p.polname = 'bcp_sectors_read') AS named
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'governance' AND c.relname = 'bcp_sectors'`);
  assert.deepEqual(rows.map((r) => [r.relname, r.relrowsecurity, r.relforcerowsecurity, r.policies, r.named]), [['bcp_sectors', true, true, 1, 1]]);
  const [grants] = await sequelize.query("SELECT has_table_privilege('nayara_runtime', 'governance.bcp_sectors', 'SELECT') AS sel WHERE EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nayara_runtime')");
  if (grants.length) assert.equal(grants[0].sel, true, 'SELECT ao role de runtime');
});

// M9-D833: as conferências do pagamento emergencial (governance.manual_operation_checks) e a pendência de conciliação com o extrato (governance.bcp_payment_pendings) são da EMPRESA.
test('M9-D833: manual_operation_checks e bcp_payment_pendings têm RLS, FORCE RLS e a política tenant_isolation por empresa', async () => {
  const tables = ['manual_operation_checks', 'bcp_payment_pendings'];
  const [rows] = await sequelize.query(`SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity,
      (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid AND p.polname = 'tenant_isolation' AND pg_get_expr(p.polqual, p.polrelid) LIKE '%app.company_id%') AS policies
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'governance' AND c.relname IN (:tables) ORDER BY 1`, { replacements: { tables } });
  assert.equal(rows.length, tables.length, 'as duas tabelas existem');
  for (const r of rows) assert.deepEqual([r.relrowsecurity, r.relforcerowsecurity, r.policies], [true, true, 1], `governance.${r.relname}`);
  for (const table of tables) {
    const [grants] = await sequelize.query(`SELECT has_table_privilege('nayara_runtime', 'governance.${table}', 'INSERT') AS ins WHERE EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nayara_runtime')`);
    if (grants.length) assert.equal(grants[0].ins, true, `GRANT ao role de runtime em ${table}`);
  }
});

// M9-D843: a chave de idempotência (governance.idempotency_keys) é da EMPRESA; o catálogo de erros (governance.error_catalog) é do sistema, com leitura aberta e escrita só na sincronização;
// o contador de requisições (governance.rate_limit_counters, UNLOGGED) não tem empresa e só abre para o limitador.
test('M9-D843: idempotency_keys, error_catalog e rate_limit_counters têm RLS, FORCE RLS e as políticas esperadas', async () => {
  const [rows] = await sequelize.query(`SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity, c.relpersistence,
      (SELECT string_agg(p.polname, ',' ORDER BY p.polname) FROM pg_policy p WHERE p.polrelid = c.oid) AS policies
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'governance' AND c.relname IN ('idempotency_keys', 'error_catalog', 'rate_limit_counters') ORDER BY 1`);
  assert.deepEqual(rows.map((r) => [r.relname, r.relrowsecurity, r.relforcerowsecurity, r.policies]), [
    ['error_catalog', true, true, 'error_catalog_read,error_catalog_sync'],
    ['idempotency_keys', true, true, 'tenant_isolation'],
    ['rate_limit_counters', true, true, 'rate_limit_writer'],
  ]);
  assert.equal(rows.find((r) => r.relname === 'rate_limit_counters').relpersistence, 'u', 'UNLOGGED');
  for (const table of ['idempotency_keys', 'error_catalog', 'rate_limit_counters']) {
    const [grants] = await sequelize.query(`SELECT has_table_privilege('nayara_runtime', 'governance.${table}', 'INSERT') AS ins WHERE EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nayara_runtime')`);
    if (grants.length) assert.equal(grants[0].ins, true, `GRANT ao role de runtime em ${table}`);
  }
});

// M9-D841: o catálogo de consumidores, o uso por alvo e as deprecações da API são da EMPRESA. A consulta do consumidor de uma credencial externa pelo client_id tem política própria, só de leitura.
test('M9-D841: api_consumers, api_consumer_usage e api_deprecations têm RLS, FORCE RLS e a política tenant_isolation por empresa', async () => {
  const tables = ['api_consumers', 'api_consumer_usage', 'api_deprecations'];
  const [rows] = await sequelize.query(`SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity,
      (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid AND p.polname = 'tenant_isolation' AND pg_get_expr(p.polqual, p.polrelid) LIKE '%app.company_id%') AS policies,
      (SELECT string_agg(p.polname, ',' ORDER BY p.polname) FROM pg_policy p WHERE p.polrelid = c.oid) AS names
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'governance' AND c.relname IN (:tables) ORDER BY 1`, { replacements: { tables } });
  assert.equal(rows.length, tables.length, 'as três tabelas existem');
  for (const r of rows) assert.deepEqual([r.relrowsecurity, r.relforcerowsecurity, r.policies], [true, true, 1], `governance.${r.relname}`);
  assert.equal(rows.find((r) => r.relname === 'api_consumers').names, 'api_consumer_client_lookup,tenant_isolation', 'consulta por client_id: política própria, só SELECT');
  for (const table of tables) {
    const [grants] = await sequelize.query(`SELECT has_table_privilege('nayara_runtime', 'governance.${table}', 'INSERT') AS ins WHERE EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nayara_runtime')`);
    if (grants.length) assert.equal(grants[0].ins, true, `GRANT ao role de runtime em ${table}`);
  }
});

// M9-D046: ai.release_gates (portão de liberação da NAY para produção) com RLS, FORCE RLS e a política tenant_isolation (linhas da empresa e do grupo).
test('M9-D046: ai.release_gates tem RLS, FORCE RLS e a política tenant_isolation', async () => {
  const [rows] = await sequelize.query(
    `SELECT c.relrowsecurity, c.relforcerowsecurity, (SELECT array_agg(p.polname::text) FROM pg_policy p WHERE p.polrelid = c.oid) AS policies
     FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'ai' AND c.relname = 'release_gates'`
  );
  assert.equal(rows.length, 1, 'ai.release_gates não existe');
  assert.equal(rows[0].relrowsecurity, true, 'RLS em ai.release_gates');
  assert.equal(rows[0].relforcerowsecurity, true, 'FORCE RLS em ai.release_gates');
  assert.deepEqual(rows[0].policies, ['tenant_isolation']);
});

// M9-D844: as credenciais da API externa são da EMPRESA (tenant_isolation); a consulta por client_id tem política própria, só de leitura. O catálogo de scopes é do sistema: leitura aberta e escrita só pela migration.
test('M9-D844: api_clients tem RLS, FORCE RLS, tenant_isolation e a consulta por client_id; api_scopes é catálogo de leitura aberta', async () => {
  const [rows] = await sequelize.query(`SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity,
      (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid AND p.polname = 'tenant_isolation' AND pg_get_expr(p.polqual, p.polrelid) LIKE '%app.company_id%') AS tenant_policies,
      (SELECT string_agg(p.polname, ',' ORDER BY p.polname) FROM pg_policy p WHERE p.polrelid = c.oid) AS names
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'governance' AND c.relname IN ('api_clients', 'api_scopes') ORDER BY 1`);
  assert.equal(rows.length, 2, 'as duas tabelas existem');
  for (const r of rows) assert.deepEqual([r.relrowsecurity, r.relforcerowsecurity], [true, true], `RLS e FORCE em governance.${r.relname}`);
  const clients = rows.find((r) => r.relname === 'api_clients');
  assert.deepEqual([clients.tenant_policies, clients.names], [1, 'api_client_lookup,tenant_isolation']);
  assert.equal(rows.find((r) => r.relname === 'api_scopes').names, 'api_scopes_catalog_write,api_scopes_read');
  const [grants] = await sequelize.query(`SELECT has_table_privilege('nayara_runtime', 'governance.api_clients', 'INSERT') AS clients_ins,
      has_table_privilege('nayara_runtime', 'governance.api_scopes', 'SELECT') AS scopes_sel
    WHERE EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nayara_runtime')`);
  if (grants.length) assert.deepEqual([grants[0].clients_ins, grants[0].scopes_sel], [true, true], 'GRANT ao role de runtime');
  // Escrita no catálogo de scopes: nenhuma política a permite sem a chave que só a migration liga (a aplicação nunca a liga).
  const [writes] = await sequelize.query("SELECT pg_get_expr(p.polwithcheck, p.polrelid) AS chk FROM pg_policy p WHERE p.polrelid = 'governance.api_scopes'::regclass AND p.polcmd IN ('a', '*')");
  assert.ok(writes.length === 1 && /app\.api_scope_catalog/.test(writes[0].chk), 'só a chave da migration libera escrita em api_scopes');
  const [seeded] = await sequelize.query("SELECT code FROM governance.api_scopes ORDER BY code");
  assert.deepEqual(seeded.map((r) => r.code), ['contracts:read', 'leads:write', 'properties:read']);
});

// M9-D234: a mensagem de e-mail e o histórico de eventos do provedor são da EMPRESA (tenant_isolation), com RLS + FORCE e GRANT ao runtime.
test('M9-D234: email_messages e email_message_events têm RLS, FORCE RLS e política por empresa', async () => {
  const [rows] = await sequelize.query(`SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity,
      (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid AND p.polname = 'tenant_isolation' AND pg_get_expr(p.polqual, p.polrelid) LIKE '%app.company_id%') AS tenant_policies
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'integration' AND c.relname IN ('email_messages', 'email_message_events') ORDER BY 1`);
  assert.equal(rows.length, 2, 'as duas tabelas existem');
  for (const r of rows) assert.deepEqual([r.relrowsecurity, r.relforcerowsecurity, r.tenant_policies], [true, true, 1], `RLS, FORCE e política por empresa em integration.${r.relname}`);
  const [grants] = await sequelize.query(`SELECT has_table_privilege('nayara_runtime', 'integration.email_messages', 'UPDATE') AS msg_upd,
      has_table_privilege('nayara_runtime', 'integration.email_message_events', 'INSERT') AS ev_ins
    WHERE EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nayara_runtime')`);
  if (grants.length) assert.deepEqual([grants[0].msg_upd, grants[0].ev_ins], [true, true], 'GRANT ao role de runtime');
});

// M9-D235: o e-mail recebido e os seus anexos são da EMPRESA (tenant_isolation), com RLS + FORCE e GRANT ao runtime.
test('M9-D235: email_inbound_messages e email_inbound_attachments têm RLS, FORCE RLS e política por empresa', async () => {
  const [rows] = await sequelize.query(`SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity,
      (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid AND p.polname = 'tenant_isolation' AND pg_get_expr(p.polqual, p.polrelid) LIKE '%app.company_id%') AS tenant_policies
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'integration' AND c.relname IN ('email_inbound_messages', 'email_inbound_attachments') ORDER BY 1`);
  assert.equal(rows.length, 2, 'as duas tabelas existem');
  for (const r of rows) assert.deepEqual([r.relrowsecurity, r.relforcerowsecurity, r.tenant_policies], [true, true, 1], `RLS, FORCE e política por empresa em integration.${r.relname}`);
  const [grants] = await sequelize.query(`SELECT has_table_privilege('nayara_runtime', 'integration.email_inbound_messages', 'UPDATE') AS msg_upd,
      has_table_privilege('nayara_runtime', 'integration.email_inbound_attachments', 'INSERT') AS att_ins
    WHERE EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nayara_runtime')`);
  if (grants.length) assert.deepEqual([grants[0].msg_upd, grants[0].att_ins], [true, true], 'GRANT ao role de runtime');
});

// M9-D238: a versão da apólice (imutável) e a tarefa do fluxo manual de seguro são da EMPRESA (tenant_isolation), com RLS + FORCE e GRANT ao runtime; a versão só se acrescenta.
test('M9-D238: insurance_policy_versions e insurance_manual_tasks têm RLS, FORCE RLS e política por empresa', async () => {
  const [rows] = await sequelize.query(`SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity,
      (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid AND p.polname = 'tenant_isolation' AND pg_get_expr(p.polqual, p.polrelid) LIKE '%app.company_id%') AS tenant_policies
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'procurement' AND c.relname IN ('insurance_policy_versions', 'insurance_manual_tasks') ORDER BY 1`);
  assert.equal(rows.length, 2, 'as duas tabelas existem');
  for (const r of rows) assert.deepEqual([r.relrowsecurity, r.relforcerowsecurity, r.tenant_policies], [true, true, 1], `RLS, FORCE e política por empresa em procurement.${r.relname}`);
  const [grants] = await sequelize.query(`SELECT has_table_privilege('nayara_runtime', 'procurement.insurance_policy_versions', 'INSERT') AS ver_ins,
      has_table_privilege('nayara_runtime', 'procurement.insurance_manual_tasks', 'UPDATE') AS task_upd
    WHERE EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nayara_runtime')`);
  if (grants.length) assert.deepEqual([grants[0].ver_ins, grants[0].task_upd], [true, true], 'GRANT ao role de runtime');
  // A versão é imutável pelo gatilho (o banco descartável concede tudo ao runtime; a migration só concede SELECT e INSERT).
  const [gatilho] = await sequelize.query("SELECT count(*)::int AS n FROM pg_trigger WHERE tgrelid = 'procurement.insurance_policy_versions'::regclass AND tgname = 'insurance_policy_versions_immutable_trg' AND NOT tgisinternal");
  assert.equal(gatilho[0].n, 1, 'gatilho de imutabilidade da versão');
});

// M9-D237: finance.bank_statement_entries (lançamentos do extrato bancário) com RLS, FORCE RLS, política por empresa e UNIQUE (connection_id, entry_id).
test('M9-D237: finance.bank_statement_entries tem RLS, FORCE RLS, a política tenant_isolation e o índice único (connection_id, entry_id)', async () => {
  const [rls] = await sequelize.query(`SELECT c.relrowsecurity AS rls, c.relforcerowsecurity AS force_rls FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'finance' AND c.relname = 'bank_statement_entries'`);
  assert.equal(rls.length, 1, 'finance.bank_statement_entries não existe');
  assert.deepEqual([rls[0].rls, rls[0].force_rls], [true, true]);
  const [pol] = await sequelize.query(`SELECT 1 FROM pg_policy p WHERE p.polname = 'tenant_isolation' AND p.polrelid = '"finance"."bank_statement_entries"'::regclass`);
  assert.equal(pol.length, 1, 'política tenant_isolation');
  const [uniq] = await sequelize.query(`SELECT indexdef FROM pg_indexes WHERE schemaname = 'finance' AND tablename = 'bank_statement_entries' AND indexname = 'bank_statement_entries_conn_entry_uidx'`);
  assert.match(uniq[0].indexdef, /UNIQUE.*\(connection_id, entry_id\)/);
  const [grant] = await sequelize.query(`SELECT has_table_privilege('nayara_runtime', 'finance.bank_statement_entries', 'INSERT') AS ins WHERE EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nayara_runtime')`);
  if (grant.length) assert.equal(grant[0].ins, true, 'GRANT ao role de runtime');
});

// M9-D232: real_estate.portal_listings (anúncio do imóvel em cada portal) com RLS, FORCE RLS, política por empresa e um anúncio ativo por (imóvel, portal).
test('M9-D232: real_estate.portal_listings tem RLS, FORCE RLS, a política tenant_isolation e o índice único parcial (property_id, connection_id)', async () => {
  const [rls] = await sequelize.query(`SELECT c.relrowsecurity AS rls, c.relforcerowsecurity AS force_rls FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'real_estate' AND c.relname = 'portal_listings'`);
  assert.equal(rls.length, 1, 'real_estate.portal_listings não existe');
  assert.deepEqual([rls[0].rls, rls[0].force_rls], [true, true]);
  const [pol] = await sequelize.query(`SELECT 1 FROM pg_policy p WHERE p.polname = 'tenant_isolation' AND p.polrelid = '"real_estate"."portal_listings"'::regclass`);
  assert.equal(pol.length, 1, 'política tenant_isolation');
  const [uniq] = await sequelize.query(`SELECT indexdef FROM pg_indexes WHERE schemaname = 'real_estate' AND tablename = 'portal_listings' AND indexname = 'portal_listings_active_uidx'`);
  assert.match(uniq[0].indexdef, /UNIQUE.*\(property_id, connection_id\).*superseded_at IS NULL/);
  const [grant] = await sequelize.query(`SELECT has_table_privilege('nayara_runtime', 'real_estate.portal_listings', 'UPDATE') AS upd WHERE EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nayara_runtime')`);
  if (grant.length) assert.equal(grant[0].upd, true, 'GRANT ao role de runtime');
});

// M9-D241: o contador do RPS é da EMPRESA (tenant_isolation), com RLS + FORCE e GRANT ao runtime; o RPS é único por empresa e série; o XML e o PDF da nota apontam para `files`.
test('M9-D241: nfse_rps_sequences tem RLS, FORCE RLS e política por empresa; RPS único; tax_documents aponta XML e PDF para files', async () => {
  const [rows] = await sequelize.query(`SELECT c.relrowsecurity, c.relforcerowsecurity,
      (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid AND p.polname = 'tenant_isolation' AND pg_get_expr(p.polqual, p.polrelid) LIKE '%app.company_id%') AS tenant_policies
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'correspondent' AND c.relname = 'nfse_rps_sequences'`);
  assert.equal(rows.length, 1, 'a tabela existe');
  assert.deepEqual([rows[0].relrowsecurity, rows[0].relforcerowsecurity, rows[0].tenant_policies], [true, true, 1]);
  const [grants] = await sequelize.query(`SELECT has_table_privilege('nayara_runtime', 'correspondent.nfse_rps_sequences', 'UPDATE') AS upd WHERE EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nayara_runtime')`);
  if (grants.length) assert.equal(grants[0].upd, true, 'GRANT ao role de runtime');
  const [indice] = await sequelize.query("SELECT indexdef FROM pg_indexes WHERE schemaname = 'correspondent' AND indexname = 'invoice_requests_rps_unique'");
  assert.match(indice[0].indexdef, /UNIQUE.*\(company_id, rps_series, rps_number\)/, 'RPS único por empresa e série');
  const [colunas] = await sequelize.query("SELECT column_name FROM information_schema.columns WHERE table_schema = 'finance' AND table_name = 'tax_documents' AND column_name IN ('xml_file_id', 'pdf_file_id') ORDER BY 1");
  assert.deepEqual(colunas.map((c) => c.column_name), ['pdf_file_id', 'xml_file_id']);
});

// M9-D259: a página do site (estado interno e sincronização com o site) é da EMPRESA (tenant_isolation), com RLS + FORCE e GRANT ao runtime.
test('M9-D259: site_pages tem RLS, FORCE RLS e política por empresa e GRANT ao runtime', async () => {
  const [rows] = await sequelize.query(`SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity,
      (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid AND p.polname = 'tenant_isolation' AND pg_get_expr(p.polqual, p.polrelid) LIKE '%app.company_id%') AS tenant_policies
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'integration' AND c.relname = 'site_pages'`);
  assert.equal(rows.length, 1, 'a tabela existe');
  assert.deepEqual([rows[0].relrowsecurity, rows[0].relforcerowsecurity, rows[0].tenant_policies], [true, true, 1], 'RLS, FORCE e política por empresa em integration.site_pages');
  const [grants] = await sequelize.query(`SELECT has_table_privilege('nayara_runtime', 'integration.site_pages', 'UPDATE') AS upd, has_table_privilege('nayara_runtime', 'integration.site_pages', 'INSERT') AS ins
    WHERE EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nayara_runtime')`);
  if (grants.length) assert.deepEqual([grants[0].upd, grants[0].ins], [true, true], 'GRANT ao role de runtime');
});

// M9-D247: a quarentena de uploads externos (resultado da verificação e hash do descartado) é da EMPRESA (tenant_isolation), com RLS + FORCE e GRANT ao runtime.
test('M9-D247: files.quarantine tem RLS, FORCE RLS e política por empresa e GRANT ao runtime', async () => {
  const [rows] = await sequelize.query(`SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity,
      (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid AND p.polname = 'tenant_isolation' AND pg_get_expr(p.polqual, p.polrelid) LIKE '%app.company_id%') AS tenant_policies
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'files' AND c.relname = 'quarantine'`);
  assert.equal(rows.length, 1, 'a tabela existe');
  assert.deepEqual([rows[0].relrowsecurity, rows[0].relforcerowsecurity, rows[0].tenant_policies], [true, true, 1], 'RLS, FORCE e política por empresa em files.quarantine');
  const [grants] = await sequelize.query(`SELECT has_table_privilege('nayara_runtime', 'files.quarantine', 'UPDATE') AS upd, has_table_privilege('nayara_runtime', 'files.quarantine', 'INSERT') AS ins
    WHERE EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nayara_runtime')`);
  if (grants.length) assert.deepEqual([grants[0].upd, grants[0].ins], [true, true], 'GRANT ao role de runtime');
});

// M9-D230: a conversa, o canal e o par externo de atendimento (identificadores internos estáveis na troca de fornecedor) são da EMPRESA (tenant_isolation), com RLS + FORCE e GRANT ao runtime.
test('M9-D230: crm.channels, crm.conversations e crm.conversation_links têm RLS, FORCE RLS e política por empresa e GRANT ao runtime', async () => {
  for (const tabela of ['channels', 'conversations', 'conversation_links']) {
    const [rows] = await sequelize.query(`SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity,
        (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid AND p.polname = 'tenant_isolation' AND pg_get_expr(p.polqual, p.polrelid) LIKE '%app.company_id%') AS tenant_policies
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'crm' AND c.relname = :t`, { replacements: { t: tabela } });
    assert.equal(rows.length, 1, `a tabela crm.${tabela} existe`);
    assert.deepEqual([rows[0].relrowsecurity, rows[0].relforcerowsecurity, rows[0].tenant_policies], [true, true, 1], `RLS, FORCE e política por empresa em crm.${tabela}`);
    const [grants] = await sequelize.query(`SELECT has_table_privilege('nayara_runtime', 'crm.${tabela}', 'UPDATE') AS upd, has_table_privilege('nayara_runtime', 'crm.${tabela}', 'INSERT') AS ins
      WHERE EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nayara_runtime')`);
    if (grants.length) assert.deepEqual([grants[0].upd, grants[0].ins], [true, true], `GRANT ao role de runtime em crm.${tabela}`);
  }
});

// M9-D860: cost_ledger e cost_read_model (RLS pelo grupo, empresa opcional), cost_accruals e cost_collector_runs (pela empresa), com FORCE e GRANT ao runtime.
test('M9-D860: tabelas do FinOps têm RLS, FORCE RLS, política tenant_isolation e GRANT ao runtime', async () => {
  const tables = ['cost_ledger', 'cost_read_model', 'cost_accruals', 'cost_collector_runs'];
  const [rows] = await sequelize.query(`SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity,
      (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid AND p.polname = 'tenant_isolation') AS policies
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'governance' AND c.relname IN (:tables) ORDER BY 1`, { replacements: { tables } });
  assert.equal(rows.length, tables.length, 'as quatro tabelas existem');
  for (const r of rows) assert.deepEqual([r.relrowsecurity, r.relforcerowsecurity, r.policies], [true, true, 1], `governance.${r.relname}`);
  for (const t of tables) {
    const [grants] = await sequelize.query(`SELECT has_table_privilege('nayara_runtime', 'governance.${t}', 'INSERT') AS ins WHERE EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nayara_runtime')`);
    if (grants.length) assert.equal(grants[0].ins, true, `GRANT ao runtime em governance.${t}`);
  }
});

// M9-D861: orçamentos e alertas de orçamento do FinOps (RLS pela empresa, FORCE, política e GRANT ao runtime).
test('M9-D861: budgets e budget_alerts têm RLS, FORCE RLS, política tenant_isolation e GRANT ao runtime', async () => {
  const tables = ['budgets', 'budget_alerts'];
  const [rows] = await sequelize.query(`SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity,
      (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid AND p.polname = 'tenant_isolation') AS policies
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'governance' AND c.relname IN (:tables) ORDER BY 1`, { replacements: { tables } });
  assert.equal(rows.length, tables.length, 'as tabelas existem');
  for (const r of rows) assert.deepEqual([r.relrowsecurity, r.relforcerowsecurity, r.policies], [true, true, 1], `governance.${r.relname}`);
  for (const t of tables) {
    const [grants] = await sequelize.query(`SELECT has_table_privilege('nayara_runtime', 'governance.${t}', 'INSERT') AS ins WHERE EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nayara_runtime')`);
    if (grants.length) assert.equal(grants[0].ins, true, `GRANT ao runtime em governance.${t}`);
  }
});

// M9-D862: achados dos detectores de desperdício do FinOps (RLS pela empresa, FORCE, política e GRANT ao runtime).
test('M9-D862: finops_findings tem RLS, FORCE RLS, política tenant_isolation e GRANT ao runtime', async () => {
  const tables = ['finops_findings'];
  const [rows] = await sequelize.query(`SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity,
      (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid AND p.polname = 'tenant_isolation') AS policies
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'governance' AND c.relname IN (:tables) ORDER BY 1`, { replacements: { tables } });
  assert.equal(rows.length, tables.length, 'as tabelas existem');
  for (const r of rows) assert.deepEqual([r.relrowsecurity, r.relforcerowsecurity, r.policies], [true, true, 1], `governance.${r.relname}`);
  for (const t of tables) {
    const [grants] = await sequelize.query(`SELECT has_table_privilege('nayara_runtime', 'governance.${t}', 'INSERT') AS ins WHERE EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nayara_runtime')`);
    if (grants.length) assert.equal(grants[0].ins, true, `GRANT ao runtime em governance.${t}`);
  }
});

// M9-D863: política e ações de degradação por custo (RLS pela empresa, FORCE, política e GRANT ao runtime).
test('M9-D863: degradation_policies e degradation_actions têm RLS, FORCE RLS, política tenant_isolation e GRANT ao runtime', async () => {
  const tables = ['degradation_actions', 'degradation_policies'];
  const [rows] = await sequelize.query(`SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity,
      (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid AND p.polname = 'tenant_isolation') AS policies
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'governance' AND c.relname IN (:tables) ORDER BY 1`, { replacements: { tables } });
  assert.equal(rows.length, tables.length, 'as tabelas existem');
  for (const r of rows) assert.deepEqual([r.relrowsecurity, r.relforcerowsecurity, r.policies], [true, true, 1], `governance.${r.relname}`);
  for (const t of tables) {
    const [grants] = await sequelize.query(`SELECT has_table_privilege('nayara_runtime', 'governance.${t}', 'INSERT') AS ins WHERE EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nayara_runtime')`);
    if (grants.length) assert.equal(grants[0].ins, true, `GRANT ao runtime em governance.${t}`);
  }
});

// M9-D870: registro de flags e configurações (RLS pela empresa, FORCE, política e GRANT ao runtime).
test('M9-D870: feature_flags, config_entries e flag_versions têm RLS, FORCE RLS, política tenant_isolation e GRANT ao runtime', async () => {
  const tables = ['config_entries', 'feature_flags', 'flag_versions'];
  const [rows] = await sequelize.query(`SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity,
      (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid AND p.polname = 'tenant_isolation') AS policies
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'governance' AND c.relname IN (:tables) ORDER BY 1`, { replacements: { tables } });
  assert.equal(rows.length, tables.length, 'as tabelas existem');
  for (const r of rows) assert.deepEqual([r.relrowsecurity, r.relforcerowsecurity, r.policies], [true, true, 1], `governance.${r.relname}`);
  for (const t of tables) {
    const [grants] = await sequelize.query(`SELECT has_table_privilege('nayara_runtime', 'governance.${t}', 'INSERT') AS ins WHERE EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nayara_runtime')`);
    if (grants.length) assert.equal(grants[0].ins, true, `GRANT ao runtime em governance.${t}`);
  }
});

// M9-D871: registro dos alertas de flags (RLS pela empresa, FORCE, política e GRANT ao runtime).
test('M9-D871: flag_alert_log tem RLS, FORCE RLS, política tenant_isolation e GRANT ao runtime', async () => {
  const [rows] = await sequelize.query(`SELECT c.relrowsecurity, c.relforcerowsecurity,
      (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid AND p.polname = 'tenant_isolation') AS policies
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'governance' AND c.relname = 'flag_alert_log'`);
  assert.equal(rows.length, 1, 'a tabela existe');
  assert.deepEqual([rows[0].relrowsecurity, rows[0].relforcerowsecurity, rows[0].policies], [true, true, 1]);
  const [grants] = await sequelize.query("SELECT has_table_privilege('nayara_runtime', 'governance.flag_alert_log', 'INSERT') AS ins WHERE EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nayara_runtime')");
  if (grants.length) assert.equal(grants[0].ins, true, 'GRANT ao runtime em governance.flag_alert_log');
});

// M9-D906: core.external_refs (IDs do sistema antigo com validade) tem RLS, FORCE RLS, política tenant_isolation e GRANT ao runtime (o DELETE é barrado pelo gatilho; ver m9d906).
test('M9-D906: external_refs tem RLS, FORCE RLS, política tenant_isolation e GRANT ao runtime', async () => {
  const [rows] = await sequelize.query(`SELECT c.relrowsecurity, c.relforcerowsecurity,
      (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid AND p.polname = 'tenant_isolation') AS policies
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'core' AND c.relname = 'external_refs'`);
  assert.equal(rows.length, 1, 'a tabela existe');
  assert.deepEqual([rows[0].relrowsecurity, rows[0].relforcerowsecurity, rows[0].policies], [true, true, 1]);
  const [grants] = await sequelize.query("SELECT has_table_privilege('nayara_runtime', 'core.external_refs', 'INSERT') AS ins WHERE EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nayara_runtime')");
  if (grants.length) assert.equal(grants[0].ins, true, 'GRANT ao runtime em core.external_refs');
});

// M9-D900: fontes, execuções, lotes, registros de origem e chaves de idempotência da migração v2 (governance.mig_*) são da EMPRESA de destino: RLS + FORCE RLS, tenant_isolation e GRANT ao runtime.
test('M9-D900: mig_sources, mig_runs, mig_batches, mig_records e mig_event_keys têm RLS, FORCE RLS, política tenant_isolation e GRANT ao runtime', async () => {
  const tables = ['mig_sources', 'mig_runs', 'mig_batches', 'mig_records', 'mig_event_keys'];
  const [rows] = await sequelize.query(`SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity,
      (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid AND p.polname = 'tenant_isolation') AS policies
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'governance' AND c.relname IN (:tables) ORDER BY 1`, { replacements: { tables } });
  assert.equal(rows.length, tables.length, 'as cinco tabelas existem');
  for (const r of rows) assert.deepEqual([r.relrowsecurity, r.relforcerowsecurity, r.policies], [true, true, 1], `governance.${r.relname}`);
  for (const t of tables) {
    const [grants] = await sequelize.query(`SELECT has_table_privilege('nayara_runtime', 'governance.${t}', 'INSERT') AS ins WHERE EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nayara_runtime')`);
    if (grants.length) assert.equal(grants[0].ins, true, `GRANT ao runtime em governance.${t}`);
  }
});
