'use strict';

// M9-D696 — o catálogo de checks: todo read model registrado declara o mínimo do livro (freshness, reconciliação, 1 invariante e completude),
// o arquivo de cada um segue o padrão <read-model>.checks.js e todo limite lido tem parâmetro no SETTINGS_SCHEMA.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const analytics = require('../../../src/features/analytics');
const quality = require('../../../src/features/analytics/quality');
const { SETTINGS_SCHEMA } = require('../../../src/features/settings/settings.service');

const { readModels } = analytics;
const CHECKS_DIR = path.join(__dirname, '../../../src/features/analytics/quality/checks');
/** Aceita o valor pelo dicionário (tipo, faixa e validador próprio), como a gravação faz; lança se a chave não existe ou o valor é recusado. */
function accepts(key, value) {
  const spec = SETTINGS_SCHEMA[key];
  if (!spec) throw new Error(`chave fora do SETTINGS_SCHEMA: ${key}`);
  if (['number', 'integer'].includes(spec.type) && ((spec.min !== undefined && value < spec.min) || (spec.max !== undefined && value > spec.max))) throw new Error(`${key}: fora da faixa`);
  if (typeof spec.validate === 'function') spec.validate(key, value);
}
const MINIMUM = [['FRESHNESS'], ['RECONCILIATION'], ['INVARIANT', 'CONSISTENCY'], ['COMPLETENESS']];

test('m9d696 todo read model declara checks', () => {
  const models = readModels.listReadModels();
  assert.ok(models.length >= 2, 'rm_finance_health e rm_finance_sector_margin estão registrados');
  for (const def of models) {
    const types = new Set(quality.getChecks(def.name).map((c) => c.type));
    for (const anyOf of MINIMUM) assert.ok(anyOf.some((t) => types.has(t)), `${def.name} não declara check ${anyOf.join('/')}`);
    assert.ok(fs.existsSync(path.join(CHECKS_DIR, `${def.name}.checks.js`)), `falta quality/checks/${def.name}.checks.js`);
  }
  assert.doesNotThrow(() => quality.assertEveryReadModelDeclaresChecks(models));
});

test('m9d696 read model sem checks reprova o catálogo (o CI falha)', () => {
  const fake = { name: 'rm_sem_checks_m9d696', keyColumns: ['x'] };
  assert.throws(() => quality.assertEveryReadModelDeclaresChecks([...readModels.listReadModels(), fake]), (e) => /rm_sem_checks_m9d696/.test(e.message) && /declarar checks/.test(e.message));
  quality.registerChecks(fake.name, [quality.types.freshness({ code: 'f', domain: 'FINANCE' })]);
  try {
    assert.throws(() => quality.assertEveryReadModelDeclaresChecks([fake]), /reconcilia/i, 'declarar um check só não basta: o mínimo do livro');
  } finally {
    quality.unregisterChecks(fake.name);
  }
});

test('m9d696 todo código de check é único e usa métricas no formato do registro', () => {
  const seen = new Set();
  for (const def of readModels.listReadModels()) {
    for (const c of quality.getChecks(def.name)) {
      assert.match(c.code, /^[a-z][a-z0-9_]*$/);
      assert.ok(!seen.has(c.code), `código repetido ${c.code}`);
      seen.add(c.code);
      for (const m of c.metrics || []) assert.match(m, /^[a-z][a-z0-9]*[.][a-z][a-z0-9_]*$/);
    }
  }
});

test('m9d696 limites e severidades são parâmetros do SETTINGS_SCHEMA com os padrões do livro', () => {
  const keys = [
    'analytics.qualidade.faixa_contagem_pct', 'analytics.qualidade.max_nulos_bloqueio_pct', 'analytics.qualidade.tolerancia_conciliacao',
    'analytics.qualidade.janela_refreshes', 'analytics.qualidade.min_refreshes_faixa', 'analytics.qualidade.severidades',
    'analytics.freshness.fator_expirado', 'analytics.freshness.max_minutos.FINANCE', 'analytics.qualidade.max_nulos_pct.due_at',
  ];
  for (const k of keys) assert.doesNotThrow(() => accepts(k, quality.DEFAULTS[k]), k);
  assert.equal(quality.DEFAULTS['analytics.qualidade.faixa_contagem_pct'], 50);
  assert.equal(quality.DEFAULTS['analytics.qualidade.max_nulos_bloqueio_pct'], 5);
  assert.equal(quality.DEFAULTS['analytics.qualidade.tolerancia_conciliacao'], 'R$ 0,01');
  assert.equal(quality.DEFAULTS['analytics.qualidade.janela_refreshes'], 14);
  assert.equal(quality.DEFAULTS['analytics.freshness.fator_expirado'], 4);
  assert.equal(quality.DEFAULTS['analytics.freshness.max_minutos.FINANCE'], 60);
  assert.equal(quality.DEFAULTS['analytics.freshness.max_minutos.TECH_AI'], 15);
  assert.equal(quality.DEFAULTS['analytics.qualidade.max_nulos_pct.due_at'], 0, 'campo usado em fórmula: 0%');
  assert.equal(quality.DEFAULTS['analytics.qualidade.max_nulos_pct.result_center_id'], 1);
  assert.equal(quality.parseSeverities(quality.DEFAULTS['analytics.qualidade.severidades']).FRESHNESS_STALE, 'WARN');
  assert.equal(quality.parseSeverities(quality.DEFAULTS['analytics.qualidade.severidades']).FRESHNESS_EXPIRED, 'BLOCK');
  assert.throws(() => accepts('analytics.qualidade.severidades', 'FRESHNESS_STALE=TALVEZ'), /severidades/i);
  assert.throws(() => accepts('analytics.qualidade.tolerancia_conciliacao', 'muito'), /tolerancia/i);
});

test('m9d696 todo campo de completude do catálogo tem parâmetro de limite', () => {
  for (const def of readModels.listReadModels()) {
    for (const c of quality.getChecks(def.name).filter((x) => x.type === 'COMPLETENESS')) {
      assert.ok(c.field, `${c.code} sem campo`);
      assert.doesNotThrow(() => accepts(`analytics.qualidade.max_nulos_pct.${c.field}`, 1), `falta analytics.qualidade.max_nulos_pct.${c.field}`);
    }
  }
});
