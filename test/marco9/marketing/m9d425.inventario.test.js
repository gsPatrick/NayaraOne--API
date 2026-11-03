'use strict';

// M9-D425 — a rota do kill switch do Marketing passa pelo núcleo de confirmação (M9-D852, linha 14 do inventário): `confirmAction('kill_switch.activate')` (nível 2, sem MFA) e
// `confirmAction('kill_switch.restore')` (nível 3, MFA, motivo), com provedor de impacto e rota /marketing/kill-switch/impact; parâmetro e permissão documentados. Sem banco de dados.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { motivoNaoAplicavel } = require('../../helpers/repoIrmao');
const { DISPOSABLE, SKIP_DISPOSABLE } = require('../../m9d801.helpers');

process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || 'segredo-de-teste-m9d425';
const skip = DISPOSABLE ? false : SKIP_DISPOSABLE;
const API = path.join(__dirname, '../../..');
const KEYS = ['kill_switch.activate', 'kill_switch.restore'];

test('a_rota_do_marketing_usa_o_guarda_nivel_2_sem_mfa_e_nivel_3_com_mfa_e_tem_rota_de_impacto', { skip }, () => {
  const { allRoutes, find } = require('../_helpers/m9d852Rotas');
  const D = require('../../../src/shared/destructive-actions');
  const routes = allRoutes();
  const action = find(routes, 'POST', '/marketing/kill-switch');
  const impact = find(routes, 'POST', '/marketing/kill-switch/impact');
  assert.ok(action.length === 1 && impact.length === 1);
  for (const key of KEYS) {
    assert.ok(action[0].guards.includes(key), `${key}: POST /marketing/kill-switch sem o guarda de confirmação`);
    assert.ok(impact[0].impacts.includes(key), `${key}: POST /marketing/kill-switch/impact sem a simulação`);
    assert.ok(D.registry.registeredKeys().includes(key));
    assert.ok(D.inventory.get(key).alsoGuarded.includes('POST /marketing/kill-switch'), `${key}: o inventário nomeia a rota do Marketing`);
  }
  assert.equal(action[0].mfa, true, 'a reativação confere o MFA recente (guarda nível 3 com mfa)');
  assert.deepEqual([D.inventory.get(KEYS[0]).level, D.inventory.get(KEYS[0]).mfa, D.inventory.get(KEYS[1]).level, D.inventory.get(KEYS[1]).mfa], [2, 'não', 3, 'sim']);
});

test('parametro_do_motivo_esta_no_dicionario_no_catalogo_na_tela_e_e_lido_pelo_codigo', { skip: motivoNaoAplicavel(['Maturacao/demandas/parametros.csv', 'NayaraOne--FRONT/app/painel/configuracoes']) }, () => {
  const key = 'marketing.killswitch.motivo_min_caracteres';
  const { SETTINGS_SCHEMA } = require('../../../src/features/settings/settings.service');
  assert.deepEqual(SETTINGS_SCHEMA[key], { type: 'integer', min: 3, max: 500 });
  const csv = fs.readFileSync(path.join(API, '../Maturacao/demandas/parametros.csv'), 'utf8');
  assert.ok(csv.split('\n').some((line) => line.startsWith(`"${key}","Marketing"`) && line.includes('"10"') && line.includes('M9-D425')), 'linha do parâmetro no catálogo com o padrão 10');
  const front = path.join(API, '../NayaraOne--FRONT/app/painel/configuracoes');
  const tab = fs.readFileSync(path.join(front, 'MarketingTab.js'), 'utf8');
  assert.match(tab, /MARKETING_KILLSWITCH_GROUPS/);
  assert.ok(fs.readFileSync(path.join(front, 'marketingKillSwitchGroups.js'), 'utf8').includes(key), 'campo na aba Marketing de Configurações');
  const reader = fs.readFileSync(path.join(API, 'src/features/marketing/killswitch.settings.js'), 'utf8');
  assert.match(reader, /getSetting\(REASON_MIN_KEY/, 'o parâmetro é lido na hora de validar o motivo');
  const input = fs.readFileSync(path.join(API, 'src/features/marketing/killswitch.input.js'), 'utf8');
  assert.match(input, /readReasonMin\(/);
});

test('nenhum_arquivo_do_kill_switch_passa_de_400_linhas', () => {
  const dir = path.join(API, 'src/features/marketing');
  const files = fs.readdirSync(dir).filter((f) => f.startsWith('killswitch.'));
  assert.ok(files.length >= 15);
  for (const f of files) assert.ok(fs.readFileSync(path.join(dir, f), 'utf8').split('\n').length <= 400, f);
});
