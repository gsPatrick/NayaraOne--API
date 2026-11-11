'use strict';

// DI-BI-5 (M9-D628, M9-D680, DI-D680-3) — "Integrações com erro" lê a última janela FECHADA do health. Cenário: às 15:10Z (12:10 de São Paulo) a janela das 14:00Z já fechou com
// 100 chamadas e 10 erros e a das 15:00Z, que o health ainda está preenchendo, tem 3 chamadas sem erro. O indicador tem de mostrar 10,00% (100 chamadas, 10 erros). Na base
// 14217771 o read model pegava a janela mais recente, inclusive a aberta, e saía 0,00% sobre 3 chamadas (no começo de cada hora, sem chamadas e INCOMPLETE). Na virada (16:00Z
// em ponto) a janela das 15:00Z fecha e passa a valer. Banco descartável (127.0.0.1).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { kit, activeConnection, healthWindow, kpiAt } = require('../_helpers/m9biJanelas');

let env;
before(async () => {
  env = await kit.setup();
  const conn = await activeConnection(env, env.cX);
  await healthWindow(env, env.cX, conn, '2026-10-28T14:00:00Z', { total: 100, failed: 10 }); // fechada às 15:00Z
  await healthWindow(env, env.cX, conn, '2026-10-28T15:00:00Z', { total: 3, failed: 0 }); // aberta até 16:00Z
});
after(() => kit.teardown(env));

test('DI-BI-5 com a janela das 15:00Z ainda aberta, Integrações com erro lê a janela fechada das 14:00Z', async () => {
  const r = await kpiAt(env, env.cX, new Date('2026-10-28T15:10:00Z'));
  assert.deepEqual([r.status, r.value, r.details.calls, r.details.errors], ['OK', '10.00', '100', '10'], 'a conta à mão: 10 erros em 100 chamadas da janela fechada = 10,00%');
  const [[row]] = await env.admin.query("SELECT calls, errors FROM analytics.rm_tech_integrations WHERE company_id = :c AND window_minutes = 60 AND provider = 'messaging-sandbox'", { replacements: { c: env.cX.companyId } });
  assert.deepEqual([Number(row.calls), Number(row.errors)], [100, 10], 'o read model guardou a janela fechada, não a aberta (3 chamadas)');
});

test('DI-BI-5 um milissegundo antes da virada a janela das 15:00Z continua de fora; na virada (16:00Z) ela fecha e passa a valer', async () => {
  const before16 = await kpiAt(env, env.cX, new Date('2026-10-28T15:59:59.999Z'));
  assert.deepEqual([before16.value, before16.details.calls], ['10.00', '100']);
  const at16 = await kpiAt(env, env.cX, new Date('2026-10-28T16:00:00.000Z'));
  assert.deepEqual([at16.status, at16.value, at16.details.calls, at16.details.errors], ['OK', '0.00', '3', '0'], 'início + duração = agora: fechada');
});
