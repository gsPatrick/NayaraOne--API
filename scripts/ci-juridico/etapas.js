'use strict';
/**
 * As 18 etapas do CI/CD do Guia do Marco 5 (§17), nesta ordem e com estes nomes literais. TODA etapa roda em todo push e
 * pull request, na ordem do livro (decisão DI-M5ES-1):
 *   - deploy_DEV e deploy_LAB publicam o artefato do commit (git archive + VERSION, como o Dockerfile) e fazem o smoke do
 *     jurídico pela API real (scripts/ci-juridico/deployLocal.js): DEV sobre o banco da esteira, LAB num banco novo migrado
 *     pelo comando de deploy. Em tag de release (jur-release-*, --release) a etapa também dispara o hook do servidor
 *     DEV/LAB do Patrick e confere o commit em /api/version (`comandosRelease`, scripts/ci-juridico/deploy.js).
 *   - failure_drills roda os drills de falha, a carga e o drill de restore completo, que grava o relatório em
 *     {evidencias}/restore; pentest grava o relatório em {evidencias}/pentest.
 *   - production_approval é o PORTÃO de produção (scripts/ci-juridico/gateProducao.js): bloqueia se faltar restore verde
 *     ou pentest verde no mesmo commit, se houver falha aberta (teste falho, pulado ou todo) ou etapa anterior não verde.
 *     Nunca faz deploy: a aprovação humana é o environment juridico-aprovacao do GitHub, só em tag.
 * `banco: true` = só roda em banco descartável (scripts/withDisposableDb.js).
 * Marcadores trocados pelo executor: {evidencias}, {relatorio}, {etapa}, {portaDrill}.
 */
const REPORTER = './scripts/ci-juridico/reporterEsteira.js';
const NODE_TEST = (...arquivos) => ['node', '--test', '--test-concurrency=1', '--test-reporter=spec', '--test-reporter-destination=stdout',
  `--test-reporter=${REPORTER}`, '--test-reporter-destination={evidencias}/testes/{etapa}.jsonl', ...arquivos];

const ETAPAS = [
  { nome: 'lint', comandos: [['npm', 'run', '-s', 'lint']] },
  { nome: 'typecheck', comandos: [['npm', 'run', '-s', 'syntax-check']] },
  { nome: 'migrations', banco: true, comandos: [['node', 'scripts/ci-juridico/migracoes.js'], ['node', 'scripts/ci-juridico/renomes-livro.js'], NODE_TEST('test/rls.catalog.allTables.test.js', 'test/m5fech.meta.tabelasDoLivro.test.js')] },
  { nome: 'contract_state_tests', banco: true, comandos: [NODE_TEST('test/m5fech.contratos.maquinaTipos.test.js', 'test/legal.contracts.test.js', 'test/m5fech.contratos.versoesAprovacao.test.js')] },
  { nome: 'requirements_tests', banco: true, comandos: [NODE_TEST('test/legal.requirements.test.js', 'test/m5fech.contratos.checklist.test.js', 'test/legal.frente5.rules.test.js')] },
  { nome: 'signature_adapter_contract_tests', banco: true, comandos: [NODE_TEST('test/legal.signatureProviders.test.js')] },
  { nome: 'signature_webhook_idempotency_tests', banco: true, comandos: [NODE_TEST('test/m5fech.contratos.webhookLiteral.test.js', 'test/m5fech.contratos.adversariais.test.js')] },
  { nome: 'inspection_immutability_tests', banco: true, comandos: [NODE_TEST('test/legal.inspections.test.js', 'test/m5fech.locacao.vistorias.test.js')] },
  { nome: 'key_delivery_gate_tests', banco: true, comandos: [NODE_TEST('test/legal.keyDeliveries.test.js', 'test/m5fech.locacao.chaves.test.js')] },
  {
    nome: 'deadline_tests',
    banco: true,
    comandos: [NODE_TEST('test/m5fech.juridico.prazos.test.js', 'test/m5fech.juridico.prazosLivro.test.js', 'test/legal.deadlineReopenCritical.test.js', 'test/legal.deadlineFinalState.test.js', 'test/legal.deadlineFinalState.concurrency.test.js', 'test/legal.deadlineRaceCritical.test.js')],
  },
  { nome: 'evidence_integrity_tests', banco: true, comandos: [NODE_TEST('test/m5fech.juridico.custodia.test.js', 'test/auditoriaNayara.marco5.coverage.test.js')] },
  { nome: 'multi_company_tests', banco: true, comandos: [NODE_TEST('test/legal.crossCompanyIsolation.test.js', 'test/ciTwoTenantsFinanceLegal.test.js', 'test/adversarial.legal.test.js')] },
  { nome: 'security_scan', comandos: [['npm', 'run', '-s', 'scan:secrets']] },
  { nome: 'deploy_DEV', banco: true, deploy: true, comandos: [['node', 'scripts/ci-juridico/deployLocal.js', 'DEV', '--evidencias', '{evidencias}']], comandosRelease: [['node', 'scripts/ci-juridico/deploy.js', 'DEV']] },
  { nome: 'deploy_LAB', banco: true, deploy: true, comandos: [['node', 'scripts/ci-juridico/deployLocal.js', 'LAB', '--evidencias', '{evidencias}']], comandosRelease: [['node', 'scripts/ci-juridico/deploy.js', 'LAB']] },
  {
    nome: 'failure_drills',
    banco: true,
    comandos: [NODE_TEST('test/m5fech.juridico.failureDrills.test.js', 'test/m5fech.juridico.carga.test.js'), ['node', 'scripts/restoreDrill/legalFullDrill.js', '--port', '{portaDrill}', '--report-dir', '{evidencias}/restore']],
  },
  { nome: 'pentest', banco: true, env: { PENTEST_M5_OUT_DIR: '{evidencias}/pentest' }, comandos: [NODE_TEST('test/m5fech.pentest.test.js')] },
  { nome: 'production_approval', aprovacao: true, comandos: [['node', 'scripts/ci-juridico/gateProducao.js', '--relatorio', '{relatorio}', '--evidencias', '{evidencias}']] },
];

const NOMES_DO_LIVRO = [
  'lint', 'typecheck', 'migrations', 'contract_state_tests', 'requirements_tests', 'signature_adapter_contract_tests',
  'signature_webhook_idempotency_tests', 'inspection_immutability_tests', 'key_delivery_gate_tests', 'deadline_tests',
  'evidence_integrity_tests', 'multi_company_tests', 'security_scan', 'deploy_DEV', 'deploy_LAB', 'failure_drills', 'pentest', 'production_approval',
];

function validar(etapas = ETAPAS) {
  const nomes = etapas.map((e) => e.nome);
  if (JSON.stringify(nomes) !== JSON.stringify(NOMES_DO_LIVRO)) throw new Error(`LEGAL_CI_STAGES_MISMATCH: ${nomes.join(',')}`);
  return true;
}

module.exports = { ETAPAS, NOMES_DO_LIVRO, NODE_TEST, REPORTER, validar };
