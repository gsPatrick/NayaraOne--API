'use strict';

/**
 * Marco 9, demanda M9-D628: read models de Tecnologia sobre integrações, eventos bloqueados e falhas de autenticação (schema analytics, RLS ENABLE +
 * FORCE por company_id).
 *  - rm_tech_integrations (provider, family, environment, window_minutes): os 9 valores de saúde de integration.provider_health (M9-D206/D224, decisão C10)
 *    na ÚLTIMA janela fechada de cada connection, somados por fornecedor, ambiente e família (as 14 de M9-D201). Latência = a pior das connections (conservador).
 *    error_limit_pct = 100 menos o sucesso mínimo do SLO da criticidade do fornecedor (integration.slo.<CRITICIDADE>);
 *  - rm_tech_blocked_events (day, reason, event_type): eventos barrados por kill switch, política de segurança, falta de consentimento e validação;
 *  - rm_tech_auth_failures (day, kind, provider): falhas de login, de MFA e de autenticação de integração, com usuários distintos por hash e o pico de falhas numa única hora do dia.
 * Nenhum nome, e-mail, IP, payload ou segredo: só contagens e códigos. Faixa reservada: 9826 a 9833.
 */
const { COUNT, createReadModelTable, grantRuntime, dropTables } = require('./_helpers/analyticsReadModelTables');

const TABLES = [
  {
    name: 'rm_tech_integrations',
    key: ['provider', 'family', 'environment', 'window_minutes'],
    columns: [
      'provider varchar(48) NOT NULL', 'family varchar(24) NOT NULL', 'environment varchar(10) NOT NULL', 'window_minutes integer NOT NULL CHECK (window_minutes >= 1)',
      COUNT('calls'), COUNT('errors'), 'success_rate numeric(5,2) CHECK (success_rate IS NULL OR (success_rate >= 0 AND success_rate <= 100))',
      'latency_p95_ms integer CHECK (latency_p95_ms IS NULL OR latency_p95_ms >= 0)', 'latency_p99_ms integer CHECK (latency_p99_ms IS NULL OR latency_p99_ms >= 0)',
      COUNT('rate_limit_count'), COUNT('auth_failures'), COUNT('retries'), COUNT('dlq'), COUNT('backlog'), 'quota_remaining integer CHECK (quota_remaining IS NULL OR quota_remaining >= 0)',
      'error_limit_pct numeric(5,2) NOT NULL DEFAULT 0 CHECK (error_limit_pct >= 0 AND error_limit_pct <= 100)', COUNT('connections'),
    ],
  },
  {
    name: 'rm_tech_blocked_events',
    key: ['day', 'reason', 'event_type'],
    columns: ['day date NOT NULL', 'reason varchar(32) NOT NULL', 'event_type varchar(128) NOT NULL', COUNT('blocked')],
  },
  {
    name: 'rm_tech_auth_failures',
    key: ['day', 'kind', 'provider'],
    columns: ['day date NOT NULL', "kind varchar(12) NOT NULL CHECK (kind IN ('LOGIN', 'MFA', 'INTEGRATION'))", 'provider varchar(48) NOT NULL', COUNT('failures'), COUNT('distinct_actors'), COUNT('peak_hour_failures')],
  },
];

module.exports = {
  up: async (queryInterface) => {
    const q = (sql) => queryInterface.sequelize.query(sql);
    await q('CREATE SCHEMA IF NOT EXISTS "analytics"');
    for (const table of TABLES) await createReadModelTable(q, table);
    await grantRuntime(q, TABLES.map((t) => t.name));
  },

  down: async (queryInterface) => {
    await dropTables((sql) => queryInterface.sequelize.query(sql), TABLES.map((t) => t.name).reverse());
  },
};
