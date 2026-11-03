'use strict';

// M9-D047 — o que fecha o Definition of Done da NAY fora do script: o runbook de operação da IA com as 7 seções, a esteira da IA que grava o relatório offline
// (reports/offline-run-ia.json, 0 chamadas externas) e o fio com a autochecagem da M9-D258 (escopo ia-nay). Sem banco.

const { test } = require('node:test');
const { testeComIrmaos } = require('../../helpers/repoIrmao');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { validateRunbook } = require('../../../src/features/integrations/health/runbooks');
const E = require('../../../scripts/ai-ci/lib/estagios');
const L = require('../../../scripts/ai-ci/lib/offlineIa');
const { carregar } = require('../../../scripts/ai-dod/lib/matriz');
const { ambienteReal } = require('../../../scripts/int-autocheck/lib/ambiente');
const { compute } = require('../../../scripts/int-autocheck/lib/compute');
const { problemasOffline } = require('../../../scripts/int-autocheck/lib/relatorio');
const { arquivosDaPasta } = require('../../../scripts/int-autocheck/lib/ambienteSuite');

const API = path.join(__dirname, '..', '..', '..');
// O _PLANO.md e o mapa de passos moram em Maturacao/demandas/marco-9 (pasta irmã, sem remoto): ausentes no CI que só tem a API (CI_SEM_REPOS_IRMAOS=1) o teste vira NAO_APLICAVEL_NO_CI; sem a variável, continua exigindo.
const testeComPlano = testeComIrmaos(['Maturacao/demandas/marco-9/_PLANO.md']);

test('m9d047_runbook_de_operacao_da_ia_tem_as_7_secoes', () => {
  const texto = fs.readFileSync(path.join(API, 'docs/runbooks/ai/operacao.md'), 'utf8');
  assert.deepEqual(validateRunbook(texto), []);
  // O runbook cita as dez métricas e os campos de log que a operação usa.
  for (const nome of ['ai_runs_total', 'ai_run_latency_ms', 'ai_cost_brl_total', 'ai_tool_calls_total', 'ai_blocked_total', 'ai_insufficient_sources_total',
    'ai_injection_detected_total', 'ai_fallback_total', 'ai_budget_pct', 'ai_provider_circuit_open', 'correlationId', 'runId']) assert.ok(texto.includes(nome), nome);
  // Sem uma seção, o validador da D258/D223 reprova (o runbook não é decorativo).
  assert.ok(validateRunbook(texto.replace('## 5. Como rotacionar credencial', '## 5. Outra coisa')).length > 0);
});

test('m9d047_esteira_da_ia_grava_o_relatorio_offline_de_toda_a_suite', () => {
  const matriz = carregar();
  const arquivos = L.arquivosDaExecucao(API, matriz);
  const toda = arquivosDaPasta(path.join(API, 'test/marco9/ia'), API);
  assert.ok(toda.every((a) => arquivos.includes(a)), 'toda a pasta test/marco9/ia entra');
  for (const fora of ['test/ai/m9d004.servico.test.js', 'test/ai/m9d005.servico.test.js']) assert.ok(arquivos.includes(fora), `${fora} prova um item do DoD e entra`);
  assert.deepEqual(arquivos, [...arquivos].sort());
  const { argv, env } = L.comandoDaExecucao(arquivos);
  assert.ok(argv.includes('--test-reporter=junit') && argv.includes('--require=./scripts/int-ci/offlineGuard.js'));
  assert.ok(argv.includes('--test-concurrency=1'));
  assert.equal(env.NODE_ENV, 'test');
  assert.equal(env.INT_OFFLINE_LOG, 'reports/ai-ci/chamadas-externas.log');
  assert.deepEqual(L.comandoDoRelatorio(), ['node', 'scripts/int-ci/offlineRelatorio.js', '--escopo', 'ia-nay', '--entrada', 'reports/ai-ci', '--saida', 'reports/offline-run-ia.json']);
  // O estágio 12 da esteira roda a execução offline e o DoD, depois dos testes de privacidade; a definição continua a do livro.
  const estagios = E.carregar(path.join(API, 'scripts/ai-ci/estagios.json'));
  const comandos = estagios[11].comandos;
  assert.equal(estagios[11].nome, 'privacy/log redaction');
  // A execução offline roda em cluster PRÓPRIO e limpo (os estágios 4 a 11 já deixaram dados no cluster da esteira; os testes de HTTP criam registros fixos e dariam 409).
  assert.deepEqual(comandos.slice(-2), [['node', 'scripts/withDisposableDb.js', '--', 'env', 'LOG_LEVEL=info', 'bash', '-c', 'node scripts/seed-ci-two-tenants.js >/dev/null && node scripts/ai-ci/offlineIa.js'], ['node', 'scripts/ai-dod-check.js']]);
  assert.equal(estagios[11].banco, true, 'só em banco descartável');
  // Fora de banco descartável a execução recusa (o .env aponta para a homologação real).
  const sem = spawnSync('node', ['scripts/ai-ci/offlineIa.js'], { cwd: API, encoding: 'utf8', env: { ...process.env, DISPOSABLE_DB: '' } });
  assert.equal(sem.status, 2);
  assert.match(sem.stderr, /só roda em banco descartável/);
  // A pasta do JUnit e o relatório não vão para o git.
  const ignorado = fs.readFileSync(path.join(API, '.gitignore'), 'utf8');
  assert.match(ignorado, /^reports\/ai-ci\/$/m);
  assert.match(ignorado, /^reports\/offline-run-ia\.json$/m);
});

testeComPlano('m9d047_marcelo_sozinho_responde_sim_com_runbook_e_relatorio_offline', () => {
  // Fatos reais do repositório (runbook de verdade) com o relatório da execução offline sintético e todo verde: as verificações (b) e (c) da D258 passam.
  const real = ambienteReal({});
  assert.deepEqual(real.runbookIa(), [], 'o runbook docs/runbooks/ai/operacao.md está completo');
  const esperados = real.arquivosEsperados('ia-nay');
  assert.ok(esperados.length > 100, 'a suíte da IA tem mais de cem arquivos');
  const relatorio = { chamadasExternas: 0, arquivos: Object.fromEntries(esperados.map((a) => [a, [['caso', 'pass']]])) };
  assert.deepEqual(problemasOffline(relatorio, esperados), []);
  const r = compute({ escopo: 'ia-nay', ambiente: { ...real, relatorioOffline: () => relatorio } });
  const marcelo = r.perguntas[0];
  const por = Object.fromEntries(marcelo.verificacoes.map((v) => [v.nome, v]));
  assert.equal(por['a suíte roda offline contra provider sandbox de modelo, com 0 chamadas externas'].ok, true);
  assert.equal(por['existe o runbook de operação da IA com as 7 seções'].ok, true);
  assert.equal(por['existem o _PLANO.md do Marco 9 e o mapa de passos e sprints'].ok, true);
  // Chamada externa na execução reprova a pergunta (0 chamadas externas é exigência).
  const externa = compute({ escopo: 'ia-nay', ambiente: { ...real, relatorioOffline: () => ({ ...relatorio, chamadasExternas: 2 }) } }).perguntas[0];
  assert.equal(externa.verificacoes[1].ok, false);
  // O relatório é gerado pelo consolidador da D258 a partir do JUnit: um JUnit de exemplo vira o JSON esperado.
  const pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'junit-ia-'));
  try {
    fs.writeFileSync(path.join(pasta, 'suite-ia.xml'), '<testsuites><testsuite name="x"><testcase name="m9d010_contrato_todos_os_adapters" file="test/marco9/ia/m9d010.contrato.test.js"/></testsuite></testsuites>');
    const saida = path.join(pasta, 'offline-run-ia.json');
    const c = spawnSync('node', ['scripts/int-ci/offlineRelatorio.js', '--escopo', 'ia-nay', '--entrada', pasta, '--saida', saida], { cwd: API, encoding: 'utf8' });
    assert.equal(c.status, 0, c.stderr);
    const json = JSON.parse(fs.readFileSync(saida, 'utf8'));
    assert.equal(json.escopo, 'ia-nay');
    assert.equal(json.chamadasExternas, 0);
    assert.deepEqual(json.arquivos['test/marco9/ia/m9d010.contrato.test.js'], [['m9d010_contrato_todos_os_adapters', 'pass']]);
  } finally { fs.rmSync(pasta, { recursive: true, force: true }); }
});
