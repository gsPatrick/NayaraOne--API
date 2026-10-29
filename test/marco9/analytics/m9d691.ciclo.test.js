'use strict';

// M9-D691 (Caderno §16 e Guia §7) — ciclo de vida do alerta: abre uma vez, conta recorrência, resolve pela política e respeita o cooldown que
// nasce da resolução. Banco descartável.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const e = require('../_helpers/m9d691Env');

let env;
let tenant;
before(async () => { env = await e.setup(); tenant = env.tenantA; });
after(() => e.teardown(env));

const D = '2026-10-29';
const at = (hhmm) => new Date(`${D}T${hhmm}:00Z`).toISOString();
async function scenario(options = {}) {
  const metric = await e.publish(env, tenant, { prefix: 'fin', criticality: 'CRITICAL' });
  const def = await e.defineAlert(tenant, metric, options);
  const step = async (hhmm, value, extra = {}) => {
    await e.put(tenant, metric, { value, at: at(hhmm), ...extra });
    return e.evaluate(tenant, at(hhmm));
  };
  return { metric, def, step };
}

test('m9d691 condição repetida com instância OPEN só incrementa ocorrências', async () => {
  env.events.length = 0;
  const { def, step } = await scenario();
  await step('10:00', '42000');
  await step('10:15', '41000');
  await step('10:30', '40000.5');
  const rows = await e.instances(env, tenant, def);
  assert.equal(rows.length, 1, 'um único alerta');
  assert.equal(rows[0].status, 'OPEN');
  assert.equal(rows[0].occurrence_count, 3);
  assert.equal(Number(rows[0].last_value), 40000.5);
  assert.equal(rows[0].severity, 'WARNING');
  assert.equal(rows[0].cooldown_until, null, 'aberta: o cooldown só nasce na resolução');
  assert.equal(rows[0].opened_at.toISOString(), at('10:00'));
  assert.equal(rows[0].last_evaluated_at.toISOString(), at('10:30'));
  assert.equal(env.events.filter((x) => x.type === 'analytics.alert.opened' && x.alertCode === def.alert_code).length, 1, 'avisa o owner uma vez só (dedupe)');
  assert.equal(env.events.find((x) => x.alertCode === def.alert_code && x.type === 'analytics.alert.opened').ownerRole, 'CFO');
});

test('m9d691 alerta repetido respeita cooldown e não duplica', async () => {
  const { def, step } = await scenario(); // WARNING: cooldown padrão de 120 min, que nasce da resolução
  await step('10:00', '42000');
  await step('10:15', '41000');
  await step('11:00', '60000');
  const resolved = await step('11:05', '61000'); // 2a avaliação normal: resolve
  assert.ok(JSON.stringify(resolved).includes('RESOLVED'));
  let rows = await e.instances(env, tenant, def);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'RESOLVED');
  assert.equal(rows[0].resolved_reason, 'CONDITION_NORMALIZED');
  assert.equal(rows[0].resolved_at.toISOString(), at('11:05'));
  assert.equal(rows[0].cooldown_until.toISOString(), at('13:05'), 'resolução + 120 min (WARNING)');
  await step('11:30', '40000'); // cai de novo dentro do cooldown
  await step('12:00', '39000');
  rows = await e.instances(env, tenant, def);
  assert.equal(rows.length, 1, 'cooldown ativo: não cria');
  assert.equal(rows[0].suppressed_count, 2, 'registra a supressão na instância resolvida');
  await step('13:10', '38000'); // cooldown vencido
  rows = await e.instances(env, tenant, def);
  assert.equal(rows.length, 2, 'nova ocorrência depois do cooldown abre outra instância');
  assert.deepEqual(rows.map((r) => r.status), ['RESOLVED', 'OPEN']);
  assert.notEqual(rows[0].id, rows[1].id);
  assert.equal(rows[1].fingerprint, rows[0].fingerprint, 'mesmo problema, mesmo fingerprint');
});

test('m9d691 cooldown conta a partir da resolução e o da definição prevalece sobre o da severidade', async () => {
  // definição com 30 min: resolvida às 11:00, cai às 11:45 -> cria (os 30 min da definição vencem os 120 do padrão WARNING)
  const own = await scenario({ cooldownMinutes: 30 });
  await own.step('10:00', '42000');
  await own.step('10:30', '60000');
  await own.step('11:00', '61000');
  let rows = await e.instances(env, tenant, own.def);
  assert.equal(rows[0].status, 'RESOLVED');
  assert.equal(rows[0].cooldown_until.toISOString(), at('11:30'), 'resolução (11:00) + 30 min da definição');
  await own.step('11:20', '40000');
  assert.equal((await e.instances(env, tenant, own.def)).length, 1, 'às 11:20 ainda em cooldown');
  await own.step('11:45', '39000');
  rows = await e.instances(env, tenant, own.def);
  assert.equal(rows.length, 2, 'às 11:45 os 30 min da definição já venceram');
  // sem cooldown na definição: vale o da severidade (WARNING 120; CRITICAL 60 pelo parâmetro)
  const bySeverity = await scenario({ severity: 'CRITICAL' });
  await bySeverity.step('10:00', '42000');
  await bySeverity.step('10:10', '60000');
  await bySeverity.step('11:00', '61000');
  rows = await e.instances(env, tenant, bySeverity.def);
  assert.equal(rows[0].cooldown_until.toISOString(), at('12:00'), 'resolução (11:00) + 60 min (CRITICAL)');
  // cooldown 0 na definição = sem silêncio
  const zero = await scenario({ cooldownMinutes: 0 });
  await zero.step('10:00', '42000');
  await zero.step('10:10', '60000');
  await zero.step('10:20', '61000');
  await zero.step('10:21', '40000');
  assert.equal((await e.instances(env, tenant, zero.def)).length, 2, 'cooldown 0: a nova ocorrência abre na hora');
});

test('m9d691 resolve após N avaliações normais e zera a contagem em avaliação anormal', async () => {
  const { def, step } = await scenario();
  await step('10:00', '42000');
  await step('10:05', '60000');
  let [row] = await e.instances(env, tenant, def);
  assert.deepEqual([row.status, row.normal_streak], ['OPEN', 1], '1 avaliação normal conta 1');
  await step('10:10', '41000'); // anormal: zera
  [row] = await e.instances(env, tenant, def);
  assert.equal(row.normal_streak, 0);
  assert.equal(row.occurrence_count, 2);
  await step('10:15', '60000');
  [row] = await e.instances(env, tenant, def);
  assert.equal(row.status, 'OPEN', 'só 1 normal depois de zerar');
  await step('10:20', '60000');
  [row] = await e.instances(env, tenant, def);
  assert.equal(row.status, 'RESOLVED');
  assert.equal(row.normal_streak, 2);
  // a política da definição (3) vence o parâmetro; o parâmetro da empresa vale sem política
  const three = await scenario({ autoResolve: { consecutiveOkEvaluations: 3 } });
  await three.step('10:00', '42000');
  await three.step('10:05', '60000');
  await three.step('10:10', '60000');
  assert.equal((await e.instances(env, tenant, three.def))[0].status, 'OPEN', 'com política de 3, duas normais não bastam');
  await three.step('10:15', '60000');
  assert.equal((await e.instances(env, tenant, three.def))[0].status, 'RESOLVED');
  await e.setSetting(env, tenant, 'analytics.alert.avaliacoes_para_resolver', 1);
  const one = await scenario();
  await one.step('10:00', '42000');
  await one.step('10:05', '60000');
  assert.equal((await e.instances(env, tenant, one.def))[0].status, 'RESOLVED', 'parâmetro analytics.alert.avaliacoes_para_resolver = 1');
  await env.admin.query("DELETE FROM core.tenant_settings WHERE company_id = :c AND key = 'analytics.alert.avaliacoes_para_resolver'", { replacements: { c: tenant.companyId } });
});

test('m9d691 reavaliar o mesmo snapshot não muda nada', async () => {
  const { def, metric, step } = await scenario();
  await step('10:00', '42000');
  const before1 = (await e.instances(env, tenant, def))[0];
  await e.evaluate(tenant, at('10:02'));
  await e.evaluate(tenant, at('10:04'));
  const after1 = (await e.instances(env, tenant, def))[0];
  assert.equal(after1.occurrence_count, 1);
  assert.equal(after1.last_evaluated_at.toISOString(), before1.last_evaluated_at.toISOString());
  assert.ok(after1.last_snapshot_id, 'guarda o snapshot avaliado');
  // normalização também não conta duas vezes o mesmo snapshot
  await e.put(tenant, metric, { value: '60000', at: at('10:10') });
  await e.evaluate(tenant, at('10:10'));
  await e.evaluate(tenant, at('10:11'));
  await e.evaluate(tenant, at('10:12'));
  const mid = (await e.instances(env, tenant, def))[0];
  assert.equal(mid.normal_streak, 1);
  assert.equal(mid.status, 'OPEN');
  // supressão em cooldown idem
  await e.put(tenant, metric, { value: '61000', at: at('10:20') });
  await e.evaluate(tenant, at('10:20'));
  assert.equal((await e.instances(env, tenant, def))[0].status, 'RESOLVED');
  await e.put(tenant, metric, { value: '40000', at: at('10:30') });
  await e.evaluate(tenant, at('10:30'));
  await e.evaluate(tenant, at('10:31'));
  assert.equal((await e.instances(env, tenant, def))[0].suppressed_count, 1, 'o mesmo snapshot suprime uma vez só');
});

test('m9d691 cooldown e limiares são parâmetros do administrador', async () => {
  await e.setSetting(env, tenant, 'analytics.alert.cooldown_minutos', 'INFO 10; WARNING 20; CRITICAL 30');
  const { def, step } = await scenario();
  await step('10:00', '42000');
  await step('10:05', '60000');
  await step('10:10', '61000');
  assert.equal((await e.instances(env, tenant, def))[0].cooldown_until.toISOString(), at('10:30'), '10:10 + 20 min do parâmetro');
  await env.admin.query("DELETE FROM core.tenant_settings WHERE company_id = :c AND key = 'analytics.alert.cooldown_minutos'", { replacements: { c: tenant.companyId } });
  const { SETTINGS_SCHEMA } = require('../../../src/features/settings/settings.service');
  for (const key of ['analytics.alert.cooldown_minutos', 'analytics.alert.avaliacoes_para_resolver', 'analytics.alert.intervalo_avaliacao_min', 'analytics.alert.owner_reserva',
    'analytics.alerta_semente.fin_free_cash_baixo', 'analytics.alerta_semente.freshness_critica', 'analytics.alerta_semente.prazo_juridico_vencido']) {
    assert.ok(SETTINGS_SCHEMA[key], `${key} está no dicionário`);
  }
});
