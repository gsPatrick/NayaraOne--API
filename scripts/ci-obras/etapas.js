'use strict';
/**
 * As 17 etapas do CI/CD do Guia do Marcelo para Obras (Marco 6, §13), nesta ordem e com estes nomes literais:
 * "lint → typecheck → migrations → baseline tests → dependency tests → daily-log tests → measurement idempotency →
 * finance-event tests → inventory integration → quality gate → warranty SLA → multi-company → concurrency → security scan →
 * DEV → LAB → load/failure tests". Cada etapa diz o que roda; o executor é o comum (scripts/lib/esteiraLivro.js).
 *   banco: true   = só roda em banco descartável (scripts/withDisposableDb.js);
 *   release: true = só em tag de release de Obras (obr-release-*): fora dela sai NAO_APLICAVEL (decisão DI-M6Q-1).
 * Marcadores: {portaDrill} (o drill de restore usa ela e a seguinte) e {portaHttp} (API real dos testes HTTP e da leitura
 * pós-restore), resolvidos pelo executor (OBR_CI_PORTA_DRILL / OBR_CI_PORTA_HTTP ou porta aleatória).
 */
const { NODE_TEST } = require('../lib/esteiraLivro');

// Arquivos novos desta esteira: lint sem nenhum aviso e no máximo 400 linhas cada (o meta-teste confere o tamanho).
const ARQUIVOS_DA_ESTEIRA = [
  'scripts/lib/esteiraLivro.js', 'scripts/ci-obras', 'scripts/ci-juridico/executar.js',
  'scripts/restoreDrill/constructionFullDrill.js', 'scripts/restoreDrill/verifyConstructionRestore.js', 'scripts/restoreDrill/verifyConstructionCatalog.js',
  'scripts/restoreDrill/verifyConstructionAppRead.js', 'scripts/restoreDrill/seedConstructionFixtures.js',
  'test/construction.adversarialHttp.test.js', 'test/construction.concorrencia.test.js', 'test/construction.carga.test.js',
  'test/construction.falhas.test.js', 'test/construction.meta.esteiraObras.test.js', 'test/helpers/obrasCarga.js',
];

const ETAPAS = [
  // O meta-teste da esteira (estático) roda aqui: ordem e nomes do livro, arquivos existentes, nenhum teste de Obras de fora, 400 linhas.
  { nome: 'lint', comandos: [['npm', 'run', '-s', 'lint'], ['npx', 'eslint', '--max-warnings=0', ...ARQUIVOS_DA_ESTEIRA], NODE_TEST('test/construction.meta.esteiraObras.test.js')] },
  { nome: 'typecheck', comandos: [['npm', 'run', '-s', 'syntax-check']] },
  { nome: 'migrations', banco: true, comandos: [['node', 'scripts/ci-juridico/migracoes.js'], NODE_TEST('test/rls.catalog.allTables.test.js')] },
  { nome: 'baseline tests', banco: true, comandos: [NODE_TEST('test/construction.budget.test.js', 'test/construction.marginRuleLifecycle.test.js', 'test/construction.costBasis.test.js')] },
  {
    nome: 'dependency tests',
    banco: true,
    comandos: [['node', '--test', '--test-concurrency=1', '--test-name-pattern', 'M6-56', 'test/construction.dailyReports.test.js'], NODE_TEST('test/construction.projectDelay.test.js')],
  },
  { nome: 'daily-log tests', banco: true, comandos: [NODE_TEST('test/construction.dailyReports.test.js', 'test/construction.missingDailyReport.test.js', 'test/construction.evidenceReuse.test.js')] },
  { nome: 'measurement idempotency', banco: true, comandos: [NODE_TEST('test/construction.measurements.test.js')] },
  { nome: 'finance-event tests', banco: true, comandos: [NODE_TEST('test/construction.minimumEvents.test.js', 'test/construction.e2e.test.js')] },
  { nome: 'inventory integration', banco: true, comandos: [NODE_TEST('test/construction.materialRequests.test.js', 'test/construction.siteReturns.test.js')] },
  {
    nome: 'quality gate',
    banco: true,
    comandos: [NODE_TEST('test/construction.nonconformities.test.js', 'test/construction.qualityItemDelete.test.js', 'test/construction.delivery.test.js', 'test/construction.evidenceFiles.test.js')],
  },
  { nome: 'warranty SLA', banco: true, comandos: [NODE_TEST('test/construction.warranty.test.js', 'test/construction.slaRules.test.js', 'test/construction.closedCaseRequirements.test.js')] },
  {
    nome: 'multi-company',
    banco: true,
    env: { CONSTRUCTION_HTTP_TEST_PORT: '{portaHttp}' },
    comandos: [NODE_TEST('test/construction.rlsWrite.test.js', 'test/construction.adminPermissions.test.js', 'test/construction.dashboard.test.js', 'test/construction.httpRoutes.test.js')],
  },
  { nome: 'concurrency', banco: true, comandos: [NODE_TEST('test/construction.lockVersion.test.js', 'test/construction.concorrencia.test.js')] },
  {
    nome: 'security scan',
    banco: true,
    env: { M6Q_HTTP_TEST_PORT: '{portaHttp}' },
    comandos: [
      ['node', 'scripts/secretScan.js'],
      ['node', 'scripts/dependencyAudit.js'],
      ['node', 'scripts/sastScan.js'],
      ['node', 'scripts/checkNaoImprovisar.js'],
      ['node', 'scripts/scanConstructionHardcode.js'],
      ['npx', 'eslint', 'src/features/construction'], // erro reprova; o único aviso hoje é uma diretiva sem uso no service de medição
      NODE_TEST('test/construction.hardcodeScanner.test.js', 'test/construction.nayNoAutomaticEffect.test.js', 'test/construction.nayObras.test.js', 'test/construction.adversarialHttp.test.js'),
    ],
  },
  { nome: 'DEV', banco: true, comandos: [['node', 'scripts/ci-obras/deployLocal.js']] },
  { nome: 'LAB', release: true, env: { CI_DEPLOY_PREFIXO: 'OBR_CI', CI_DEPLOY_ORIGEM: 'esteira-obras' }, comandos: [['node', 'scripts/ci-juridico/deploy.js', 'LAB']] },
  {
    nome: 'load/failure tests',
    banco: true,
    comandos: [
      NODE_TEST('test/construction.failureDrills.test.js', 'test/construction.falhas.test.js', 'test/construction.carga.test.js'),
      ['node', 'scripts/restoreDrill/constructionFullDrill.js', '--port', '{portaDrill}', '--http-port', '{portaHttp}', '--report-dir', 'reports/obras-ci'],
    ],
  },
];

const NOMES_DO_LIVRO = [
  'lint', 'typecheck', 'migrations', 'baseline tests', 'dependency tests', 'daily-log tests', 'measurement idempotency', 'finance-event tests',
  'inventory integration', 'quality gate', 'warranty SLA', 'multi-company', 'concurrency', 'security scan', 'DEV', 'LAB', 'load/failure tests',
];

function validar(etapas = ETAPAS) {
  const nomes = etapas.map((e) => e.nome);
  if (JSON.stringify(nomes) !== JSON.stringify(NOMES_DO_LIVRO)) throw new Error(`CONSTRUCTION_CI_STAGES_MISMATCH: ${nomes.join(',')}`);
  return true;
}

module.exports = { ETAPAS, NOMES_DO_LIVRO, ARQUIVOS_DA_ESTEIRA, validar };
