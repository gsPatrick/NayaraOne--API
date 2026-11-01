'use strict';

// M9-D682 (reabertura F08, 01/11/2026) — o quadro de freshness e as demais listas de fonte mostram o NOME em português do read model, nunca "Rm ai cost" nem o prefixo rm_.
const { test } = require('node:test');
const assert = require('node:assert/strict');
require('../../../src/features/analytics/read-models'); // registra todos os read models
const { listReadModels } = require('../../../src/features/analytics/read-models/readModel.registry');
const { readModelLabel, READ_MODEL_LABELS } = require('../../../src/features/analytics/dashboards/dashboard.readModelLabels');
const { buildBody, humanize } = require('../../../src/features/analytics/dashboards/dashboard.shape');
const { TECH_PANEL } = require('../../../src/features/analytics/dashboards/panels/tech.panel');

test('m9d682 todo read model registrado tem nome em português no catálogo', () => {
  const missing = listReadModels().map((m) => m.name).filter((n) => !READ_MODEL_LABELS[n]);
  assert.deepEqual(missing, [], 'read model sem nome em português');
  for (const [code, label] of Object.entries(READ_MODEL_LABELS)) {
    assert.ok(!/^rm\b/i.test(label) && !/_/.test(label) && !/\./.test(label), `${code}: rótulo sem prefixo nem sublinhado (${label})`);
  }
});

test('m9d682 linhas do quadro de freshness saem com o nome do read model', () => {
  const widget = TECH_PANEL.widgets.find((w) => w.metricCode === 'tec.freshness');
  const config = widget.config || {};
  const body = buildBody('TABLE', { ...config, group: 'rm' }, { unit: 'COUNT', value: '1' }, [
    { key: 'rm:rm_ai_cost:idade_min', value: '5' }, { key: 'rm:rm_tech_auth_failures:idade_min', value: '9' }, { key: 'rm:rm_crm_lead_daily:idade_min', value: '1' },
  ], []);
  assert.deepEqual(body.items.map((i) => i.label).sort(), ['Custo de IA', 'Falhas de autenticação', 'Leads por dia'].sort());
  assert.ok(body.items.every((i) => /^rm_/.test(i.id)), 'o código continua só no identificador da linha');
});

test('m9d682 humanização de código comum não muda e read model desconhecido não vira "Rm ..."', () => {
  assert.equal(humanize('VISIT_SCHEDULED'), 'Visit scheduled');
  assert.equal(readModelLabel('rm_novo_modelo'), 'Novo modelo');
  assert.equal(humanize('rm_novo_modelo'), 'Novo modelo');
});
