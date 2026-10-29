'use strict';

/**
 * M9-D695 (3.1) — catálogo FECHADO da NAY Diretoria: as 7 ferramentas de leitura do BI. Todas LOW/READ, idempotentes, sem aprovação, com
 * parâmetros tipados e enumerados: código de indicador e de painel por padrão restrito, período e dimensão por padrão, status e severidade
 * por enum. Nenhum parâmetro aceita texto de consulta. A empresa NÃO é parâmetro do modelo (D017/D018: companyId vem do servidor); o serviço
 * aceita `companyId` para os briefings, validado contra o escopo. O texto que volta (títulos, descrições) é DADO, nunca instrução.
 */
const { NAY_TOOL_NAMES } = require('./nayTools.names');
const { PERIOD_PATTERN } = require('./nayTools.period');

const metricCode = { type: 'string', pattern: '^[a-z][a-z0-9_]*(\\.[a-z][a-z0-9_]*)+$', maxLength: 80, description: 'Código do indicador no registro de métricas.' };
const dashboardCode = { type: 'string', pattern: '^[a-z][a-z0-9_]*$', maxLength: 80, description: 'Código do painel publicado.' };
const period = (description) => ({ type: 'string', pattern: PERIOD_PATTERN, maxLength: 10, description });
const dimension = { type: 'string', pattern: '^[a-z][a-z0-9_]{0,39}$', maxLength: 40, description: 'Dimensão declarada pelo indicador.' };
const obj = (properties, required) => ({ type: 'object', properties, required, additionalProperties: false });
const nullableText = { type: ['string', 'null'] };
const periodOut = obj({ label: { type: 'string' }, startDate: { type: 'string' }, endDate: { type: 'string' }, asOfDate: { type: 'string' } }, ['asOfDate']);
const freshnessOut = obj({ asOfDate: { type: 'string' }, sourceSnapshotAt: nullableText, refreshedAt: nullableText }, ['asOfDate']);

const base = { version: 1, permissionCode: 'analytics:read', riskLevel: 'LOW', category: 'READ', domain: 'OTHER', requiresHumanApproval: false, idempotent: true };
const call = (method) => (ctx, input) => ctx.services.analyticsBi[method](input);

const DEFINITIONS = [
  {
    ...base, name: 'analytics.getMetric', description: 'Valor de um indicador do BI num período, já calculado e gravado pelo sistema (com unidade, versão, natureza e frescor). Não calcula nada.',
    inputSchema: obj({ metricCode, period: period('Mês AAAA-MM, trimestre AAAA-Qn, ano AAAA ou dia AAAA-MM-DD.') }, ['metricCode', 'period']),
    outputSchema: obj({
      metricCode: { type: 'string' }, period: periodOut, value: nullableText, unit: { type: 'string' }, status: { type: 'string' }, version: { type: 'integer' },
      valueNature: nullableText, valueNatureLabel: nullableText, freshness: freshnessOut,
    }, ['metricCode', 'value', 'period']),
    execute: call('getMetric'),
  },
  {
    ...base, name: 'analytics.getMetricVariation', description: 'Variação de um indicador entre dois períodos (diferença e percentual sobre o primeiro), calculada pelo sistema.',
    inputSchema: obj({ metricCode, periodA: period('Período de partida.'), periodB: period('Período comparado.') }, ['metricCode', 'periodA', 'periodB']),
    outputSchema: obj({
      metricCode: { type: 'string' }, unit: { type: 'string' }, periodA: periodOut, periodB: periodOut, valueA: nullableText, valueB: nullableText, delta: nullableText, deltaPercent: nullableText,
      statusA: { type: 'string' }, statusB: { type: 'string' }, freshnessA: freshnessOut, freshnessB: freshnessOut,
    }, ['metricCode', 'valueA', 'valueB']),
    execute: call('getMetricVariation'),
  },
  {
    ...base, name: 'analytics.getMetricBreakdown', description: 'Decomposição de um indicador por uma dimensão que ele declara (por exemplo, por setor), com os valores já gravados.',
    inputSchema: obj({ metricCode, period: period('Período do número.'), dimension }, ['metricCode', 'period', 'dimension']),
    outputSchema: obj({
      metricCode: { type: 'string' }, dimension: { type: 'string' }, period: periodOut, truncated: { type: 'boolean' },
      items: { type: 'array', items: obj({ dimensionValue: { type: 'string' }, value: nullableText, status: { type: 'string' } }, ['dimensionValue']) },
    }, ['metricCode', 'items']),
    execute: call('getMetricBreakdown'),
  },
  {
    ...base, name: 'analytics.listAlerts', description: 'Alertas do BI da empresa, filtrados por status e severidade (só dos indicadores que o usuário pode ver).',
    inputSchema: obj({ status: { type: 'string', enum: ['OPEN', 'ACKNOWLEDGED', 'RESOLVED'] }, severity: { type: 'string', enum: ['INFO', 'WARNING', 'CRITICAL'] } }, []),
    outputSchema: obj({
      truncated: { type: 'boolean' },
      items: {
        type: 'array',
        items: obj({
          alertId: { type: 'string' }, alertCode: { type: 'string' }, metricCode: { type: 'string' }, status: { type: 'string' }, severity: { type: 'string' }, openedAt: nullableText,
          acknowledgedAt: nullableText, resolvedAt: nullableText, lastEvaluatedAt: nullableText, lastValue: nullableText, occurrenceCount: { type: 'integer' },
        }, ['alertId', 'status', 'severity']),
      },
    }, ['items']),
    execute: call('listAlerts'),
  },
  {
    ...base, name: 'analytics.getSourceRefs', description: 'De onde vem o número: tipo e tabela de origem, quantidade de registros e descrição. Nunca traz os registros nem os ids.',
    inputSchema: obj({ metricCode, period: period('Período do número.') }, ['metricCode', 'period']),
    outputSchema: obj({
      metricCode: { type: 'string' }, period: periodOut, truncated: { type: 'boolean' },
      sourceRefs: {
        type: 'array',
        items: obj({ type: { type: 'string' }, table: { type: 'string' }, filterHash: { type: 'string' }, count: { type: 'integer' }, description: nullableText, reconcileMode: nullableText, restricted: { type: 'boolean' } }, ['type', 'table']),
      },
    }, ['metricCode', 'sourceRefs']),
    execute: call('getSourceRefs'),
  },
  {
    ...base, name: 'analytics.getDashboardSummary', description: 'Resumo de um painel publicado: seus indicadores com o último número gravado de cada um.',
    inputSchema: obj({ dashboardCode }, ['dashboardCode']),
    outputSchema: obj({
      dashboardCode: { type: 'string' }, name: { type: 'string' }, domain: nullableText, version: { type: 'integer' },
      widgets: {
        type: 'array',
        items: obj({
          position: { type: 'integer' }, type: { type: 'string' }, title: nullableText, metricCode: nullableText, value: nullableText, unit: nullableText, status: nullableText,
          valueNature: nullableText, asOfDate: nullableText, freshness: { anyOf: [freshnessOut, { type: 'null' }] },
        }, ['position', 'type']),
      },
    }, ['dashboardCode', 'widgets']),
    execute: call('getDashboardSummary'),
  },
  {
    ...base, name: 'analytics.getFreshness', description: 'Quão recente é o número de um indicador: dia da última gravação, instante da fonte e idade em minutos.',
    inputSchema: obj({ metricCode }, ['metricCode']),
    outputSchema: obj({
      metricCode: { type: 'string' }, hasData: { type: 'boolean' }, asOfDate: nullableText, status: nullableText, sourceSnapshotAt: nullableText, refreshedAt: nullableText, ageMinutes: { type: ['integer', 'null'] },
    }, ['metricCode', 'hasData']),
    execute: call('getFreshness'),
  },
];

if (DEFINITIONS.map((d) => d.name).join() !== NAY_TOOL_NAMES.join()) throw new Error('Catálogo da NAY Diretoria fora dos 7 nomes do livro.');
const NAY_TOOL_DEFINITIONS = Object.freeze(DEFINITIONS.map((d) => Object.freeze(d)));

module.exports = { NAY_TOOL_DEFINITIONS };
