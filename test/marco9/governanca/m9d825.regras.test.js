'use strict';

// M9-D825 — regras puras (sem banco): varredura do corpo, máscara, registro de campos e parâmetros.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { collect, applyMask } = require('../../../src/features/core-governance/dlp/view.scan');
const { maskValue, FULL_MASK } = require('../../../src/features/core-governance/dlp/view.mask');
const settings = require('../../../src/features/core-governance/dlp/view.settings');
const { normalizeKey } = require('../../../src/features/core-governance/dlp/view.fields');
const anomalySettings = require('../../../src/features/core-governance/dlp/anomaly.settings');
const { toRow } = require('../../../src/features/core-governance/dlp/anomaly.signal');
const { VIEW_SCOPES } = require('../../../src/features/core-governance/dlp/view.routes');

const FIELDS = { [normalizeKey('taxIdNormalized')]: 'RESTRICTED', [normalizeKey('birth_date')]: 'HIGH' };

test('m9d825 a varredura acha os campos por classe e o recurso mais próximo, nas listas e nos aninhados', () => {
  const body = { success: true, data: [{ id: 'p1', taxIdNormalized: '123', name: 'Ana', contacts: [{ id: 'c1', birthDate: '2000-01-01' }] }, { id: 'p2', tax_id_normalized: '456' }, { id: 'p3', taxIdNormalized: null }] };
  const found = collect(body, FIELDS);
  assert.deepEqual(found.RESTRICTED, { ids: ['p1', 'p2'], hits: 2 }, 'nulo não conta e a chave em snake_case é reconhecida');
  assert.deepEqual(found.HIGH, { ids: ['c1'], hits: 1 });
});

test('m9d825 a máscara cobre só as classes pedidas e o resto fica intacto', () => {
  const body = { data: [{ id: 'p1', taxIdNormalized: '52998224725', birthDate: '2000-01-01', name: 'Ana' }] };
  const masked = applyMask(body, FIELDS, ['RESTRICTED'], { keep: 4, full: false });
  assert.equal(masked, 1);
  assert.deepEqual(body.data[0], { id: 'p1', taxIdNormalized: '****4725', birthDate: '2000-01-01', name: 'Ana' });
  applyMask(body, FIELDS, ['HIGH', 'RESTRICTED'], { keep: 0, full: true });
  assert.deepEqual([body.data[0].taxIdNormalized, body.data[0].birthDate, body.data[0].name], [FULL_MASK, FULL_MASK, 'Ana']);
});

test('m9d825 valor curto, número, objeto e nulo saem sem vazar o conteúdo', () => {
  assert.equal(maskValue('12345678-9', { keep: 4 }), '****78-9');
  assert.equal(maskValue('1234', { keep: 4 }), FULL_MASK, 'curto demais para mostrar a ponta');
  assert.equal(maskValue('12345678', { keep: 0 }), FULL_MASK, 'mascara total quando o parâmetro é 0');
  assert.equal(maskValue(98765432, { keep: 4 }), FULL_MASK);
  assert.equal(maskValue({ banco: '001' }, { keep: 4 }), FULL_MASK);
  assert.equal(maskValue(null, { keep: 4 }), null);
  assert.equal(maskValue('12345678', { keep: 2, full: true }), FULL_MASK, 'falha da política: sempre total');
});

test('m9d825 o registro de campos do parâmetro é validado e tem padrão para cada módulo do livro', () => {
  const defaults = settings.fieldsOf(settings.VIEW_SETTING_DEFAULTS[settings.FIELDS_KEY]);
  for (const type of ['people.person', 'properties.property', 'finance.bank_account', 'legal.contract', 'files.file']) assert.ok(defaults[type], type);
  assert.equal(defaults['finance.bank_account'].accountNumber, 'RESTRICTED');
  assert.equal(settings.parseFields('tipo sem dois pontos'), null);
  assert.equal(settings.parseFields('a.b: campo SECRETO'), null, 'classe fora do vocabulário');
  assert.equal(settings.parseFields('A.B: campo HIGH'), null, 'tipo em maiúsculas');
  assert.deepEqual(settings.fieldsOf('texto inválido'), defaults, 'valor inválido cai no padrão');
  assert.deepEqual(settings.fieldsOf('x.y: a RESTRICTED, b low'), { 'x.y': { a: 'RESTRICTED', b: 'LOW' } });
  assert.equal(settings.maskTailOf(undefined), 4);
  assert.equal(settings.maskTailOf(0), 0);
  assert.equal(settings.auditWindowOf(0), 1);
  const { SETTINGS_SCHEMA } = require('../../../src/features/settings/settings.service');
  for (const key of [settings.FIELDS_KEY, settings.MASK_TAIL_KEY, settings.AUDIT_WINDOW_KEY]) assert.ok(SETTINGS_SCHEMA[key], `${key} está no SETTINGS_SCHEMA`);
});

test('m9d825 as seis áreas do livro estão no escopo da política de VIEW', () => {
  assert.deepEqual(VIEW_SCOPES.map((s) => s.prefix).sort(), ['/files', '/finance', '/legal/contracts', '/people', '/procurement', '/properties']);
});

test('m9d824 os limiares e as horas do parâmetro têm formato validado e padrão do livro', () => {
  const defaults = anomalySettings.parseThresholds(anomalySettings.ANOMALY_SETTING_DEFAULTS[anomalySettings.THRESHOLDS_KEY]);
  assert.deepEqual(defaults, { HIGH: { limit: 200, minutes: 10 }, RESTRICTED: { limit: 20, minutes: 10 }, EXPORT: { limit: 3, minutes: 30 } });
  assert.deepEqual(anomalySettings.parseThresholds('lixo'), defaults);
  assert.deepEqual(anomalySettings.parseThresholds('EXPORT 5/60').EXPORT, { limit: 5, minutes: 60 });
  assert.deepEqual(anomalySettings.parseThresholds('EXPORT 5/60').HIGH, defaults.HIGH, 'item ausente cai no padrão');
  const { SETTINGS_SCHEMA } = require('../../../src/features/settings/settings.service');
  assert.throws(() => SETTINGS_SCHEMA[anomalySettings.THRESHOLDS_KEY].validate(anomalySettings.THRESHOLDS_KEY, 'HIGH 200/10'), /HIGH, RESTRICTED e EXPORT/);
  assert.equal(anomalySettings.ANOMALY_SETTING_DEFAULTS[anomalySettings.CONFIRMED_HOURS_KEY], 168);
  for (const key of [anomalySettings.MFA_HOURS_KEY, anomalySettings.SUSPENSION_HOURS_KEY, anomalySettings.CONFIRMED_HOURS_KEY, anomalySettings.THRESHOLDS_KEY]) assert.ok(SETTINGS_SCHEMA[key], key);
  assert.equal(anomalySettings.ANOMALY_SETTING_DEFAULTS[anomalySettings.MFA_HOURS_KEY], 24);
  assert.equal(anomalySettings.ANOMALY_SETTING_DEFAULTS[anomalySettings.SUSPENSION_HOURS_KEY], 24);
});

test('m9d824 do sinal do guard à linha: o que gera sinal e o que não gera', () => {
  const base = { actorUserId: 'u1', classification: 'HIGH', decision: 'ALLOW', resourceType: 'x', occurredAt: new Date(), count: 3 };
  assert.deepEqual([toRow({ ...base, action: 'VIEW' }).kind, toRow({ ...base, action: 'VIEW' }).count], ['READ', 3]);
  assert.equal(toRow({ ...base, action: 'COPY', decision: 'DENY' }).outcome, 'DENIED');
  assert.equal(toRow({ ...base, action: 'COPY' }).kind, 'COPY');
  for (const action of ['EXPORT', 'SHARE', 'PRINT']) assert.equal(toRow({ ...base, action, classification: 'LOW' }).kind, 'EXPORT', `${action} conta em qualquer classe`);
  assert.equal(toRow({ ...base, action: 'VIEW', classification: 'MEDIUM' }), null);
  assert.equal(toRow({ ...base, action: 'AI' }), null);
  assert.equal(toRow({ ...base, action: 'VIEW', actorUserId: null }), null);
  assert.equal(toRow({ ...base, action: 'VIEW', count: undefined }).count, 1);
});
