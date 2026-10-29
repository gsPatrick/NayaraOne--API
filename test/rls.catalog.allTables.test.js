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
