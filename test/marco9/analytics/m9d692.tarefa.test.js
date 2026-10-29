'use strict';

// M9-D692 (Caderno §16) — alerta CRITICAL com create_task abre UMA tarefa por instância, atribuída ao owner, com prazo configurável; a
// repetição não cria outra; nova instância depois da resolução e do cooldown cria a sua. Falha da tarefa desfaz a abertura. Banco descartável.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const e = require('../_helpers/m9d692Env');

let env;
let tenant;
before(async () => { env = await e.setup(); tenant = env.tenantA; });
after(() => e.teardown(env));

const D = '2026-10-29';
const at = (hhmm) => new Date(`${D}T${hhmm}:00Z`).toISOString();

async function scenario(options = {}) {
  const metric = await e.publish(env, tenant, { prefix: 'fin', criticality: 'CRITICAL' });
  const role = await e.makeRole(env, tenant);
  const users = [await e.makeUser(env, tenant, { role }), await e.makeUser(env, tenant, { role })].sort();
  const def = await e.define(env, tenant, metric, { severity: 'CRITICAL', createTask: true, ownerRole: role.name, ...options });
  const step = async (hhmm, value) => {
    await e.put(tenant, metric, { value, at: at(hhmm) });
    return e.evaluate(tenant, at(hhmm));
  };
  return { metric, role, users, def, step };
}

test('m9d692 alerta crítico cria exatamente uma tarefa e repetição não cria outra', async () => {
  const { def, users, step } = await scenario();
  await step('10:00', '42000');
  await step('10:15', '41000');
  await step('10:30', '40000');
  const [instance] = await e.instances(env, tenant, def);
  assert.equal(instance.occurrence_count, 3);
  const key = require('node:crypto').createHash('sha256').update(`analytics.alert_instance:${instance.id}`).digest('hex');
  const tasks = (await e.tasksOf(env, tenant)).filter((t) => t.action_key === key);
  assert.equal(tasks.length, 1, 'uma tarefa para a instância');
  const [task] = tasks;
  assert.equal(instance.task_id, task.id, 'o id da tarefa vai em alert_instances.task_id');
  assert.equal(task.title, `Alerta crítico: ${def.alert_code}`);
  assert.equal(task.related_entity_type, 'analytics.alert_instance');
  assert.equal(task.related_entity_id, instance.id, 'source = analytics.alert_instance:<id>');
  assert.equal(task.assigned_to_user_id, users[0], 'atribuída a um usuário ativo do papel owner');
  assert.equal(task.status, 'OPEN');
  assert.equal(new Date(task.due_at).toISOString(), new Date(new Date(at('10:00')).getTime() + 24 * 3600 * 1000).toISOString(), 'prazo padrão de 24 h');
  assert.match(task.description, /\/painel\//, 'o link para o painel vai na tarefa');
  assert.doesNotMatch(`${task.title} ${task.description}`, /4[0-2]000/, 'nenhum valor na tarefa');
});

test('m9d692 o prazo da tarefa vem do parâmetro analytics.alert.prazo_tarefa_horas', async () => {
  await e.setSetting(env, tenant, 'analytics.alert.prazo_tarefa_horas', 48);
  const { def, step } = await scenario();
  await step('11:00', '30000');
  const [instance] = await e.instances(env, tenant, def);
  const task = (await e.tasksOf(env, tenant)).find((t) => t.id === instance.task_id);
  assert.equal(new Date(task.due_at).toISOString(), new Date(new Date(at('11:00')).getTime() + 48 * 3600 * 1000).toISOString());
  await env.admin.query("DELETE FROM core.tenant_settings WHERE company_id = :c AND key = 'analytics.alert.prazo_tarefa_horas'", { replacements: { c: tenant.companyId } });
});

test('m9d692 create_task fora de CRITICAL é recusado', async () => {
  const metric = await e.publish(env, tenant, { prefix: 'fin', criticality: 'CRITICAL' });
  for (const severity of ['INFO', 'WARNING']) {
    await assert.rejects(
      e.define(env, tenant, metric, { severity, createTask: true }),
      (err) => err.statusCode === 422 && err.code === 'ANALYTICS_ALERT_TASK_ONLY_CRITICAL' && err.message === 'Somente alertas críticos podem criar tarefa ou ocorrência.'
    );
  }
  await assert.rejects(
    env.admin.query(
      `INSERT INTO analytics.alert_definitions (company_id, group_id, alert_code, metric_code, condition_type, threshold, severity, owner_role, create_task)
       VALUES (:c, :g, :code, :m, 'THRESHOLD', '{"operator":"LT","value":1}', 'WARNING', 'CFO', true)`,
      { replacements: { c: tenant.companyId, g: tenant.groupId, code: `al_${e.sup.sfx()}`, m: metric.code } }),
    /alert_definitions_task_only_critical/, 'o banco é a trava final'
  );
});

test('m9d692 alerta CRITICAL sem create_task não cria tarefa', async () => {
  const { def, step } = await scenario({ createTask: false });
  const before = (await e.tasksOf(env, tenant)).length;
  await step('12:00', '1000');
  const [instance] = await e.instances(env, tenant, def);
  assert.equal(instance.task_id, null);
  assert.equal((await e.tasksOf(env, tenant)).length, before);
});

test('m9d692 falha ao criar tarefa desfaz a abertura da instância', async () => {
  const { def, users, metric } = await scenario({ code: `m9d692_fail_${e.sup.sfx()}` });
  const trigger = `m9d692_fail_${e.sup.sfx()}`;
  await env.admin.query(`CREATE OR REPLACE FUNCTION public.${trigger}() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN RAISE EXCEPTION 'falha simulada da tarefa'; END $f$`);
  await env.admin.query(`CREATE TRIGGER ${trigger} BEFORE INSERT ON core.tasks FOR EACH ROW WHEN (NEW.title LIKE 'Alerta crítico: m9d692_fail%') EXECUTE FUNCTION public.${trigger}()`);
  env.made.triggers.push(trigger);
  await e.put(tenant, metric, { value: '100', at: at('13:00') });
  const out = await e.evaluate(tenant, at('13:00'));
  assert.equal(out.failed.length, 1, 'a avaliação da definição falhou e foi registrada');
  assert.equal((await e.instances(env, tenant, def)).length, 0, 'nenhuma instância ficou aberta');
  const notes = (await env.admin.query('SELECT 1 FROM core.notifications WHERE user_id IN (:u) AND created_at > now() - interval \'1 minute\' AND title LIKE :t', { replacements: { u: users, t: `%${def.alert_code}%` } }))[0];
  assert.equal(notes.length, 0, 'nenhum aviso saiu');
  await env.admin.query(`DROP TRIGGER ${trigger} ON core.tasks`);
  await e.put(tenant, metric, { value: '99', at: at('13:10') });
  const retry = await e.evaluate(tenant, at('13:10'));
  assert.equal(retry.failed.length, 0);
  const [instance] = await e.instances(env, tenant, def);
  assert.ok(instance && instance.task_id, 'sem a falha, abre com a tarefa');
});

test('m9d692 nova instância depois da resolução cria nova tarefa e repetição dentro do cooldown não', async () => {
  const { def, step } = await scenario({ autoResolve: { consecutiveOkEvaluations: 1 }, cooldownMinutes: 30 });
  await step('14:00', '10');
  await step('14:10', '10'); // repetição: mesma instância
  await step('14:20', '90000'); // normaliza e resolve; cooldown de 30 min a partir daqui
  await step('14:30', '10'); // dentro do cooldown: não abre, não cria tarefa
  let rows = await e.instances(env, tenant, def);
  assert.equal(rows.length, 1, 'dentro do cooldown nada novo');
  assert.equal(rows[0].status, 'RESOLVED');
  await step('14:55', '10'); // cooldown vencido: alerta novo
  rows = await e.instances(env, tenant, def);
  assert.equal(rows.length, 2);
  const tasks = await e.tasksOf(env, tenant);
  const mine = rows.map((r) => tasks.find((t) => t.id === r.task_id));
  assert.ok(mine[0] && mine[1] && mine[0].id !== mine[1].id, 'cada instância tem a sua tarefa');
  assert.equal(mine[0].status, 'OPEN', 'resolver o alerta não conclui a tarefa');
});
