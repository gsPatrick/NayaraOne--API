'use strict';

// M9-D442 — o drill é um portão: divergência reprova (MKT_DRILL_FAILED, saída diferente de zero) e o relatório traz canal, cenário, esperado, obtido e aprovado. Inclui uma divergência
// REAL (sandbox que duplica post num reenvio) para provar que o ensaio enxerga o defeito que existe para pegar. Banco descartável.
const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { sequelize } = require('../../../src/models');
const env = require('../_helpers/mktDrillEnv');
const R = require('../../../src/features/marketing/publications/drill/drill.report');
const { runCli, parseArgs } = require('../../../src/features/marketing/publications/drill/drill.cli');

let picked;
before(async () => { picked = await env.setup(); });
after(async () => { await sequelize.close(); });
afterEach(() => env.adapters.resetSandbox());

const failingReport = () => R.finish({
  startedAt: new Date().toISOString(),
  baseline: [R.row('SITE', 'OK', 'base', true, 'ok')],
  rows: [R.row('SITE', 'TIMEOUT', 'esperado A', true, 'obtido A'), R.row('SITE', 'HTTP_429', 'sem rajada', false, 'enviou duas vezes')],
}, new Date());

test('drill_retorna_nao_zero_em_divergencia: relatório reprovado vira MKT_DRILL_FAILED e saída 1', async () => {
  const report = failingReport();
  assert.equal(report.passed, false);
  assert.throws(() => R.assertPassed(report), (e) => e.statusCode === 422 && e.code === 'MKT_DRILL_FAILED' && e.message === 'O failure drill encontrou comportamento inesperado no canal.'
    && e.details.divergencias.length === 1 && e.details.divergencias[0].cenario === 'HTTP_429' && e.details.divergencias[0].obtido === 'enviou duas vezes');
  const lines = [];
  const code = await runCli(['--canal=SITE', `--saida=${fs.mkdtempSync(path.join(os.tmpdir(), 'qa-m9-drill-'))}`], {
    out: (l) => lines.push(l), err: (l) => lines.push(l),
    impl: { runDrill: async () => ({ report, recorded: [] }), toText: R.toText, writeReport: R.writeReport },
  });
  assert.equal(code, 1);
  assert.ok(lines.some((l) => /REPROVADO.*SITE.*HTTP_429/.test(l)));
  assert.ok(lines.some((l) => /MKT_DRILL_FAILED/.test(l)));
});

test('relatorio_traz_canal_cenario_esperado_obtido_e_aprovado_e_e_gravado_em_json', () => {
  const report = failingReport();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-m9-drill-'));
  const file = R.writeReport(report, dir);
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(Object.keys(saved.rows[0]).sort(), ['aprovado', 'canal', 'cenario', 'esperado', 'obtido']);
  assert.equal(saved.summary.combinacoes, 2);
  assert.equal(R.assertPassed(R.finish({ startedAt: new Date().toISOString(), baseline: [], rows: [R.row('SITE', 'TIMEOUT', 'a', true, 'b')] }, new Date())).passed, true);
  assert.equal(R.finish({ startedAt: new Date().toISOString(), baseline: [], rows: [] }, new Date()).passed, false, 'ensaio vazio não aprova');
  assert.equal(R.finish({ startedAt: new Date().toISOString(), baseline: [R.row('SITE', 'OK', 'a', false, 'b')], rows: [R.row('SITE', 'TIMEOUT', 'a', true, 'b')] }, new Date()).passed, false, 'caso de base reprovado reprova');
});

test('uso_incorreto_ou_banco_nao_local_sai_com_2_sem_tocar_o_banco', async () => {
  const quiet = { out: () => {}, err: () => {} };
  assert.equal(await runCli(['--canal=ORKUT'], quiet), 2);
  assert.equal(await runCli(['--canal=SITE'], { ...quiet, env: { DB_HOST: 'banco.exemplo.invalid' }, impl: { runDrill: () => { throw new Error('não deveria rodar'); } } }), 2);
  assert.equal(await runCli(['--canal=SITE'], { ...quiet, env: {}, impl: { runDrill: () => { throw new Error('não deveria rodar'); } } }), 2, 'sem endereço do banco também recusa');
  assert.deepEqual(parseArgs(['--canal=SITE', '--registrar', '--empresa=x']), { canal: 'SITE', registrar: true, empresa: 'x' });
});

test('divergencia_real: sandbox que duplica post no reenvio reprova UNKNOWN_BUT_PUBLISHED e o portão fecha', async () => {
  const restore = env.duplicatingSandbox('SITE');
  try {
    const { report } = await env.drill.runDrill({ channels: ['SITE'], companyId: picked.tenant.companyId });
    const bad = report.rows.filter((r) => !r.aprovado).map((r) => r.cenario);
    assert.ok(bad.includes('UNKNOWN_BUT_PUBLISHED') || bad.includes('TIMEOUT'), `o ensaio deveria reprovar o cenário de resposta incerta; reprovados: ${bad.join(',')}`);
    assert.equal(report.passed, false);
    assert.throws(() => R.assertPassed(report), (e) => e.code === 'MKT_DRILL_FAILED');
    const lines = [];
    const code = await runCli(['--canal=SITE', `--saida=${fs.mkdtempSync(path.join(os.tmpdir(), 'qa-m9-drill-'))}`], { out: (l) => lines.push(l), err: () => {}, env: process.env });
    assert.equal(code, 1, lines.slice(-4).join(' | '));
  } finally {
    restore();
  }
});
