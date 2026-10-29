'use strict';

// M9-D698 (3.2) — todo read model registrado tem índice único por (company_id, chave do agregado): sem ele o read store não cumpre o papel.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const sup = require('../../analytics.m9d603.support');
const { sequelize } = require('../../testHelpers');
const readModels = require('../../../src/features/analytics/read-models');

let env;
before(async () => { env = await sup.setup(); });
after(async () => { await env.admin.close(); await sequelize.close(); });

test('m9d698 todo read model tem índice único iniciado por company_id e seguido da chave', async () => {
  const models = readModels.listReadModels().filter((m) => /^rm_(finance|crm|rental|project|postwork|inventory|tool|mkt|support|sales|property)/.test(m.name));
  assert.ok(models.length >= 2);
  for (const def of models) {
    const [rows] = await env.admin.query(
      `SELECT i.indexrelid::regclass::text AS name, array_agg(a.attname::text ORDER BY k.ord) AS cols
         FROM pg_index i JOIN pg_class c ON c.oid = i.indrelid JOIN pg_namespace n ON n.oid = c.relnamespace
         CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord)
         JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = k.attnum
        WHERE n.nspname = 'analytics' AND c.relname = :t AND i.indisunique GROUP BY i.indexrelid`, { replacements: { t: def.name } }
    );
    const wanted = ['company_id', ...def.keyColumns];
    assert.ok(rows.some((r) => JSON.stringify(r.cols) === JSON.stringify(wanted)), `${def.name}: falta índice único (${wanted.join(', ')}); há ${JSON.stringify(rows.map((r) => r.cols))}`);
  }
});
