'use strict';

/**
 * M9-D707 — os 11 itens do Definition of Done do BI (livro §22 / Guia §15) e a prova automática de cada um. `demandas`: todas precisam estar
 * `verificada` (com verificador independente, conferido pelo `demandas-check.js`). `testes`: arquivos/padrões que rodam em banco descartável;
 * `nomes`: testes que precisam aparecer verdes pelo nome; `quinze`: os 15 nomes adversariais `m9d704 advNN`. `etapasCi`: etapas da esteira do
 * BI (M9-D705) que precisam estar APROVADAS na evidência. `comandos`: scripts sem banco que precisam sair com 0.
 * O DoD NÃO inclui o aceite dos owners para produção (M9-D708): isso é condição de PRODUÇÃO, não de LAB.
 */
const A = 'test/marco9/analytics';
const T = (...arquivos) => ({ arquivos });
const N = (arquivo, ...nomes) => ({ arquivos: [arquivo], nomes });

const ITENS = [
  { n: 1, chave: 'registry', livro: 'Metric registry/versioning', demandas: ['M9-D603', 'M9-D604'],
    testes: [T('test/analytics.m9d603.test.js', 'test/analytics.m9d603.read.test.js', 'test/analytics.m9d604.test.js'),
      N(`${A}/m9d610.naturezas.test.js`, 'm9d610 toda métrica seed tem exatamente uma value_nature'), N(`${A}/m9d712.tabela.test.js`, 'm9d712 nenhuma metrica fica sem criticidade apos o seed')],
    comandos: [['node', 'scripts/analytics/checkFormulaTests.js']] },
  { n: 2, chave: 'read-models', livro: 'Read models', demandas: ['M9-D607', 'M9-D615', 'M9-D616', 'M9-D617', 'M9-D618', 'M9-D619', 'M9-D627', 'M9-D628'],
    testes: [T(`${A}/m9d607.*.test.js`, `${A}/m9d615.worker.test.js`, `${A}/m9d616.worker.test.js`, `${A}/m9d617.worker.test.js`, `${A}/m9d627.worker.test.js`,
      `${A}/m9d618.replay.test.js`, `${A}/m9d618.rebuild.test.js`, `${A}/m9d619.replay.test.js`, `${A}/m9d619.rebuild.test.js`, `${A}/m9d628.replay.test.js`, `${A}/m9d628.rebuild.test.js`)] },
  { n: 3, chave: 'snapshots', livro: 'Snapshots/freshness', demandas: ['M9-D609'],
    testes: [N(`${A}/m9d609.snapshotDiario.test.js`, 'm9d609 snapshot diário às 00:30 SP grava D-1 com a versão vigente', 'm9d609 job executado duas vezes não duplica'), T(`${A}/m9d609.freshness.test.js`)] },
  { n: 4, chave: 'dashboards', livro: 'Dashboards', demandas: ['M9-D687', 'M9-D626', 'M9-D634', 'M9-D643', 'M9-D654', 'M9-D662', 'M9-D673', 'M9-D682', 'M9-D685', 'M9-D686'],
    testes: [N(`${A}/m9d687.paineis.test.js`, 'm9d687 seed cria os 12 painéis e o command_center sem duplicar')] },
  { n: 5, chave: 'drill-down', livro: 'Drill-down', demandas: ['M9-D690', 'M9-D712'],
    testes: [N(`${A}/m9d690.detalhe.test.js`, 'm9d690 soma do detalhe iguala o KPI'), N(`${A}/m9d690.escopo.test.js`, 'm9d690 cross-company detail é bloqueado com 404'),
      N(`${A}/m9d690.criticos.test.js`, 'm9d690 todo KPI CRITICAL de M9-D712 tem drill-down habilitado'), T(`${A}/m9d712.drilldown.test.js`)] },
  { n: 6, chave: 'alerts', livro: 'Alerts', demandas: ['M9-D691', 'M9-D692', 'M9-D703'], testes: [T(`${A}/m9d691.*.test.js`, `${A}/m9d692.*.test.js`, `${A}/m9d703.*.test.js`)] },
  { n: 7, chave: 'quality', livro: 'Quality checks', demandas: ['M9-D696', 'M9-D697'], testes: [T(`${A}/m9d696.*.test.js`, `${A}/m9d697.*.test.js`)] },
  { n: 8, chave: 'nay-briefs', livro: 'NAY briefs', demandas: ['M9-D693', 'M9-D694', 'M9-D695'], testes: [T(`${A}/m9d693.*.test.js`, `${A}/m9d694.*.test.js`, `${A}/m9d695.*.test.js`)] },
  { n: 9, chave: 'export-security', livro: 'Export security', demandas: ['M9-D701'], testes: [T(`${A}/m9d701.*.test.js`, `${A}/m9d700.mascaramento.test.js`)] },
  { n: 10, chave: 'adversariais', livro: '15 testes adversariais', demandas: ['M9-D704'], testes: [T(`${A}/m9d704.adversarial.test.js`)], quinze: true },
  { n: 11, chave: 'carga-rebuild-rls', livro: 'Carga/rebuild/RLS verdes (e fórmula/reconciliação do Guia)', demandas: ['M9-D699', 'M9-D608', 'M9-D700'], testes: [], etapasCi: [4, 6, 7, 11] },
];

module.exports = { ITENS };
