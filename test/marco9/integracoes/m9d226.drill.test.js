'use strict';

// Marco 9, M9-D226 — failure drill: o ensaio de falha derruba o sandbox, valida ativação, tarefa manual e recuperação e grava o relatório (roda em banco descartável).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const env = require('../_helpers/m9d226Env');
const { runFailureDrill } = require('../../../src/features/integrations/contingency/drill/drill.run');
const { checkLocalDatabase } = require('../../../src/features/integrations/contingency/drill/drill.guard');

const { sequelize, carregarTenants, contingency } = env;
let tenant;
const pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'm9d226-drill-'));

before(async () => { ({ tenant } = await carregarTenants()); contingency.installContingency(); });
after(async () => { await env.limparContingencias(tenant); await env.desativarConexoesDeTeste(tenant); fs.rmSync(pasta, { recursive: true, force: true }); await sequelize.close(); });

test('failure_drill_gera_relatorio', async () => {
  for (const [provider, scenario] of [['messaging-sandbox', 'provider-down'], ['portal-sandbox', 'auth-failed'], ['messaging-sandbox', 'paused'], ['messaging-sandbox', 'timeout']]) {
    await env.desativarConexoesDeTeste(tenant);
    await env.semConexoes(tenant, provider.startsWith('portal') ? 'PORTAL' : 'MESSAGING');
    const { report, file } = await runFailureDrill({ provider, scenario, companyId: tenant.companyId, outDir: pasta });
    assert.equal(report.passed, true, `${provider}/${scenario}: ${JSON.stringify(report.steps.filter((s) => !s.ok))}`);
    assert.deepEqual(report.steps.map((s) => s.name), [
      'fornecedor_de_laboratorio', 'empresa_do_ensaio', 'connection_de_laboratorio', 'derrubar_o_sandbox', 'contingencia_ativada', 'tarefa_manual_gerada',
      'alternativo_nao_configurado_mantem_a_fila', 'recuperar_o_sandbox', 'contingencia_encerrada', 'fila_liberada', 'limpeza',
    ]);
    const gravado = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepEqual([gravado.kind, gravado.provider, gravado.scenario, gravado.passed], ['contingency-failure-drill', provider, scenario, true]);
    assert.ok(!/postgres|password|secret/i.test(JSON.stringify(gravado)), 'o relatório não leva segredo nem conexão');
  }
  // 429 do fornecedor não é falha dele: o circuito não abre e a contingência não é ativada
  await env.desativarConexoesDeTeste(tenant);
  await env.semConexoes(tenant, 'MESSAGING');
  const limite = await runFailureDrill({ provider: 'messaging-sandbox', scenario: 'rate-limit', companyId: tenant.companyId, outDir: pasta });
  assert.equal(limite.report.passed, true, JSON.stringify(limite.report.steps.filter((x) => !x.ok)));
  assert.deepEqual(limite.report.steps.map((x) => x.name), ['fornecedor_de_laboratorio', 'empresa_do_ensaio', 'connection_de_laboratorio', 'derrubar_o_sandbox', 'contingencia_nao_ativada', 'recuperar_o_sandbox', 'limpeza']);
  const r = await runFailureDrill({ provider: 'anthropic', scenario: 'provider-down', companyId: tenant.companyId, outDir: pasta });
  assert.equal(r.report.passed, false, 'fornecedor real não entra no ensaio');
  assert.equal(r.report.steps[0].name, 'fornecedor_de_laboratorio');
});

test('failure_drill_script_roda_so_em_banco_local', async () => {
  assert.equal(checkLocalDatabase({ DATABASE_URL: 'postgres://u:p@127.0.0.1:5432/x' }).ok, true);
  assert.equal(checkLocalDatabase({ DATABASE_URL: 'postgres://u:p@db.exemplo.com.br:5432/x' }).ok, false);
  assert.equal(checkLocalDatabase({ DB_HOST: 'localhost' }).ok, true);
  assert.equal(checkLocalDatabase({}).ok, false, 'sem endereço informado, não roda');
  const script = path.resolve(__dirname, '../../../scripts/failureDrill.js');
  const remoto = spawnSync(process.execPath, [script, 'messaging-sandbox', 'provider-down'], { env: { PATH: process.env.PATH, DATABASE_URL: 'postgres://u:p@db.exemplo.com.br:5432/x' }, encoding: 'utf8' });
  assert.equal(remoto.status, 2);
  assert.match(remoto.stderr, /só roda contra banco local/);
  const semArgs = spawnSync(process.execPath, [script], { env: { PATH: process.env.PATH }, encoding: 'utf8' });
  assert.equal(semArgs.status, 2);
  assert.match(semArgs.stderr, /Uso:/);
  await env.semConexoes(tenant, 'MESSAGING');
  const comBanco = spawnSync(process.execPath, [script, 'messaging-sandbox', 'provider-down', '--company', tenant.companyId, '--out', pasta], { env: { ...process.env, LOG_LEVEL: 'error' }, encoding: 'utf8' });
  assert.equal(comBanco.status, 0, comBanco.stdout + comBanco.stderr);
  assert.match(comBanco.stdout, /ENSAIO APROVADO/);
  assert.ok(fs.readdirSync(pasta).some((f) => f.startsWith('failure-drill-messaging-sandbox-provider-down')));
});
