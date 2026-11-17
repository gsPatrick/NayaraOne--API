'use strict';

// Proteção do fluxo operacional contra a leitura do BI (BI §19/§21; carga em escala cheia da etapa 13, 16/11/2026): no máximo
// analytics.consulta.max_simultaneas transações de leitura do BI ao mesmo tempo por processo; as outras esperam a vez (em ordem), a requisição que
// já tem a vez não pede outra, e quem espera mais que o tempo máximo de consulta recebe 503 ANALYTICS_READ_BUSY. Antes não havia limite: cada GET
// abria a sua transação no banco do fluxo operacional.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createGate, gate, PADRAO_LIMITE } = require('../../../src/features/analytics/readOnly/readOnly.concurrency');
const { comVez } = require('../../../src/features/analytics/readOnly/readOnly.middleware');
const { READ_ONLY_SETTING_DEFAULTS, MAX_CONCURRENT_SETTING_KEY } = require('../../../src/features/analytics/readOnly/readOnly.settings');
const http = require('../_helpers/analyticsHttpEnv');

const pausa = (ms) => new Promise((r) => { setTimeout(r, ms); });
let env;
before(async () => { env = await http.setup(); });
after(async () => {
  await env.admin.query('DELETE FROM core.tenant_settings WHERE key = :k', { replacements: { k: MAX_CONCURRENT_SETTING_KEY } });
  gate.configurar({ limite: PADRAO_LIMITE, esperaMaxMs: READ_ONLY_SETTING_DEFAULTS['analytics.consulta.timeout_ms'] });
  gate.esquecer();
  await http.teardown(env);
});

test('m9d699 a porta deixa no máximo N leituras ao mesmo tempo e as demais entram em ordem de chegada', async () => {
  const g = createGate({ limite: 2, esperaMaxMs: 5000 });
  const ordem = [];
  let ativos = 0;
  let pico = 0;
  await Promise.all([0, 1, 2, 3, 4].map(async (i) => {
    const sair = await g.entrar();
    ordem.push(i);
    ativos += 1; pico = Math.max(pico, ativos);
    await pausa(15);
    ativos -= 1;
    sair();
    sair(); // devolver duas vezes não abre vaga a mais
  }));
  assert.equal(pico, 2);
  assert.deepEqual(ordem, [0, 1, 2, 3, 4]);
  assert.equal(g.estado().ativos, 0);
  assert.equal(g.estado().esperaram, 3);
});

test('m9d699 quem espera mais que o tempo máximo recebe ANALYTICS_READ_BUSY; subir o limite libera a fila', async () => {
  const g = createGate({ limite: 1, esperaMaxMs: 30 });
  const sair = await g.entrar();
  await assert.rejects(g.entrar(), (e) => e.code === 'ANALYTICS_READ_BUSY');
  assert.equal(g.estado().recusados, 1);
  g.configurar({ esperaMaxMs: 5000 });
  const esperando = g.entrar();
  g.configurar({ limite: 2 });
  const sair2 = await esperando;
  assert.equal(g.estado().ativos, 2);
  sair(); sair2();
  assert.equal(g.estado().ativos, 0);
});

test('m9d699 o GET de BI pede a vez na porta, uma vez por requisição, e a espera estourada vira 503', async () => {
  gate.configurar({ limite: 2, esperaMaxMs: 5000 });
  let ativos = 0;
  let pico = 0;
  const trabalho = (req) => comVez(req, async () => {
    ativos += 1; pico = Math.max(pico, ativos);
    await comVez(req, () => pausa(10)); // a mesma requisição dentro da vez: não pede outra (sem trava)
    ativos -= 1;
    return 'ok';
  });
  const r = await Promise.all(Array.from({ length: 6 }, () => trabalho({})));
  assert.deepEqual(r, Array(6).fill('ok'));
  assert.equal(pico, 2);
  gate.configurar({ limite: 1, esperaMaxMs: 20 });
  const longa = comVez({}, () => pausa(80));
  await assert.rejects(comVez({}, async () => 'nunca'), (e) => e.statusCode === 503 && e.code === 'ANALYTICS_READ_BUSY');
  await longa;
});

test('m9d699 o limite é o parâmetro analytics.consulta.max_simultaneas, lido na transação do GET (padrão 3)', async () => {
  assert.equal(READ_ONLY_SETTING_DEFAULTS[MAX_CONCURRENT_SETTING_KEY], 3);
  await env.admin.query('DELETE FROM core.tenant_settings WHERE key = :k', { replacements: { k: MAX_CONCURRENT_SETTING_KEY } });
  gate.configurar({ limite: 7, esperaMaxMs: 5000 });
  gate.esquecer();
  const padrao = await env.call('GET', '/analytics/dashboards/health', { perms: ['analytics:read'] });
  assert.equal(padrao.status, 200, JSON.stringify(padrao.body));
  assert.equal(gate.estado().limite, 3, 'sem parâmetro vale o padrão');
  await env.admin.query(`INSERT INTO core.tenant_settings (id, group_id, company_id, key, value) VALUES (gen_random_uuid(), :g, :c, :k, CAST('5' AS jsonb))
    ON CONFLICT (company_id, key) DO UPDATE SET value = EXCLUDED.value`, { replacements: { g: env.tenantA.groupId, c: env.tenantA.companyId, k: MAX_CONCURRENT_SETTING_KEY } });
  gate.esquecer();
  const r = await env.call('GET', '/analytics/dashboards/health', { perms: ['analytics:read'] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(gate.estado().limite, 5, 'o parâmetro da empresa vale');
});
