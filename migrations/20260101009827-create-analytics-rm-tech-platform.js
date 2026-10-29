'use strict';

/**
 * Marco 9, demanda M9-D628: read models de Tecnologia (schema analytics, RLS ENABLE + FORCE por company_id) que descrevem a saúde da plataforma.
 * As métricas técnicas são do sistema (sem empresa): cada empresa guarda a sua cópia, porque o RLS do BI é por empresa, e a leitura é só com
 * analytics:read:tech (M9-D700).
 *  - rm_tech_availability (probe, day): sondas feitas (checks), bem-sucedidas (up) e esperadas (expected, pelo intervalo configurado) por dia de São Paulo; as ausentes são expected menos checks;
 *  - rm_tech_queues (queue, event_type): profundidade, instante do item mais antigo (a idade em segundos sai da medição, DI-D628-3) e DLQ;
 *  - rm_tech_freshness (read_model): limite de idade, instante da última atualização da fonte e o estado FRESH, STALE, EXPIRED ou UNKNOWN.
 * Só contagens, nomes de fila/sonda/read model e instantes. Faixa reservada: 9826 a 9833.
 */
const { COUNT, createReadModelTable, grantRuntime, dropTables } = require('./_helpers/analyticsReadModelTables');

const TABLES = [
  {
    name: 'rm_tech_availability',
    key: ['probe', 'day'],
    columns: ['probe varchar(32) NOT NULL', 'day date NOT NULL', COUNT('checks'), COUNT('up'), COUNT('expected'), 'CONSTRAINT rm_tech_availability_up_chk CHECK (up <= checks)'],
  },
  {
    name: 'rm_tech_queues',
    key: ['queue', 'event_type'],
    columns: ['queue varchar(16) NOT NULL', 'event_type varchar(128) NOT NULL', COUNT('depth'), 'oldest_at timestamptz', COUNT('dlq_depth')],
  },
  {
    name: 'rm_tech_freshness',
    key: ['read_model'],
    columns: [
      'read_model varchar(64) NOT NULL', 'max_age_minutes integer NOT NULL CHECK (max_age_minutes >= 1)', 'last_snapshot_at timestamptz',
      "state varchar(8) NOT NULL CHECK (state IN ('FRESH', 'STALE', 'EXPIRED', 'UNKNOWN'))",
    ],
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
