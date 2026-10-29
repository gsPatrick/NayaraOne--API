'use strict';

/**
 * M9-D670 / M9-D671 — definição, no Metric Registry, dos oito KPIs de Marketing. Os 15 campos do livro (M9-D603): fonte (o read model de cada KPI), fórmula
 * versionada no código (formulas/mkt*.js, id = código do indicador), dimensões, unidade, owner (parâmetro analytics.owner.<código>), política de atualização e
 * regra de qualidade, como escritos nas demandas e na tabela de criticidade (M9-D712). Versão 1. Nenhum é CRITICAL: não têm drill-down próprio nesta entrega
 * além da origem registrada (sourceSpecs.marketing).
 */
const REFERENCE_REPORT = 'Relatório de conciliação de KPIs de Marketing (M9-D708): campanhas, custo, leads, atribuição, entregabilidade, opt-out, frequência e automações conforme o módulo Marketing';
const EVENT = Object.freeze({ mode: 'EVENT', maxStalenessMinutes: 15 });
const DAILY = Object.freeze({ mode: 'SCHEDULE', cron: '5 0 * * *', maxStalenessMinutes: 1440 });
const quality = (requiredFields) => ({ referenceReport: REFERENCE_REPORT, maxStalenessMinutes: 15, requiredFields, allowNull: true });
const dailyQuality = (requiredFields) => ({ ...quality(requiredFields), maxStalenessMinutes: 1440 });

const DEFINITIONS = Object.freeze([
  {
    metricCode: 'mkt.campaigns', name: 'Campanhas ativas e encerradas', sourceReadModel: 'rm_mkt_campaigns', unit: 'COUNT', valueNature: 'ACTUAL', criticality: 'NORMAL', refreshPolicy: EVENT,
    description: 'Quantas campanhas de marketing estão ativas hoje e quantas encerraram no mês, por canal.',
    formulaSemantic: 'Contagem de campanhas ativas na data-base e encerradas no mês de São Paulo da data-base, por canal (os canais da campanha unidos por +). Campanha ativa ou encerrada no mês sem canal deixa o KPI DEGRADED.',
    dimensions: ['empresa', 'canal', 'campanha'], qualityRule: quality(['channels', 'state']),
  },
  {
    metricCode: 'mkt.cost', name: 'Custo de marketing', sourceReadModel: 'rm_mkt_campaign_month', unit: 'BRL', valueNature: 'ACTUAL', criticality: 'NORMAL', refreshPolicy: EVENT,
    description: 'Quanto custou o marketing no mês: despesas realizadas ligadas às campanhas, por campanha e canal; o que ainda vai vencer fica à parte.',
    formulaSemantic: 'Soma das saídas liquidadas (SETTLED) ligadas a campanhas no mês de São Paulo, por campanha e canal; pendentes em details.planned. Campanha que rodou no mês sem centro de custo deixa o custo INCOMPLETE para ela e o KPI INCOMPLETE.',
    dimensions: ['empresa', 'campanha', 'canal'], qualityRule: quality(['cost_settled', 'has_cost_link']),
  },
  {
    metricCode: 'mkt.leads', name: 'Leads de marketing', sourceReadModel: 'rm_mkt_campaign_month', unit: 'COUNT', valueNature: 'ACTUAL', criticality: 'NORMAL', refreshPolicy: EVENT,
    description: 'Quantos leads com origem de marketing chegaram no mês, por campanha, incluindo os que não vieram de campanha alguma.',
    formulaSemantic: 'Contagem de leads com origem de marketing criados no mês de São Paulo, por campanha e canal, com os sem campanha em "Sem campanha". Acima de analytics.qualidade.max_sem_campanha_pct (padrão 20) sem campanha deixa o KPI DEGRADED.',
    dimensions: ['empresa', 'campanha', 'canal'], qualityRule: quality(['leads_total']),
  },
  {
    metricCode: 'mkt.attribution', name: 'Atribuição e custo por lead', sourceReadModel: 'rm_mkt_campaign_month', unit: 'BRL', valueNature: 'ACTUAL', criticality: 'NORMAL', refreshPolicy: DAILY,
    description: 'Quanto custou cada lead e cada venda atribuídos às campanhas, com a atribuição que o Marketing gravou.',
    formulaSemantic: 'Por campanha no mês: leads atribuídos (toque LAST), custo por lead = custo ÷ leads (2 casas; zero leads = INCOMPLETE), vendas atribuídas e custo por venda; toque FIRST como dimensão. Atribuição fora da janela fica fora do cálculo e em details.outsideWindow.',
    dimensions: ['empresa', 'campanha', 'canal'], qualityRule: dailyQuality(['cost_settled', 'leads_last', 'sales_last']),
  },
  {
    metricCode: 'mkt.deliverability', name: 'Entregabilidade', sourceReadModel: 'rm_mkt_delivery', unit: 'PERCENT', valueNature: 'ACTUAL', criticality: 'NORMAL', refreshPolicy: EVENT,
    description: 'Que parte das mensagens de marketing enviadas chegou ao destino no mês.',
    formulaSemantic: 'Entregabilidade = entregues ÷ enviadas × 100 (2 casas) no mês de São Paulo, por canal e campanha; falhas e devolvidas em details; zero enviadas = INCOMPLETE. Mensagem sem status de entrega há mais de analytics.qualidade.mkt_entrega_max_horas (padrão 24) deixa o KPI DEGRADED.',
    dimensions: ['empresa', 'canal', 'campanha'], qualityRule: quality(['sent', 'delivered', 'bounced']),
  },
  {
    metricCode: 'mkt.opt_out', name: 'Opt-out', sourceReadModel: 'rm_mkt_optout_month', unit: 'PERCENT', valueNature: 'ACTUAL', criticality: 'NORMAL', refreshPolicy: EVENT,
    description: 'Quantas pessoas pediram para sair das mensagens de marketing no mês, em relação às pessoas alcançadas.',
    formulaSemantic: 'Taxa de opt-out = pedidos de saída no mês ÷ contatos alcançados no mês × 100 (2 casas), por canal; a contagem absoluta sai em saidas_qtd. Opt-out sem data deixa o KPI DEGRADED.',
    dimensions: ['empresa', 'canal', 'campanha'], qualityRule: quality(['reached', 'opt_outs', 'undated']),
  },
  {
    metricCode: 'mkt.frequency', name: 'Frequência de contato', sourceReadModel: 'rm_mkt_frequency', unit: 'NUMBER', valueNature: 'ACTUAL', criticality: 'NORMAL', refreshPolicy: DAILY,
    description: 'Quantas mensagens de marketing, em média, cada pessoa alcançada recebeu na janela, e quantas pessoas passaram do teto de frequência.',
    formulaSemantic: 'Média de mensagens de automação ou campanha por pessoa alcançada na janela que termina na data-base (analytics.frequencia.janela_dias, padrão 7) e pessoas acima do teto de marketing.frequency_cap.global (deve ser zero). Mensagem sem destinatário identificável deixa o KPI DEGRADED.',
    dimensions: ['empresa', 'canal'], qualityRule: dailyQuality(['window_messages', 'window_people', 'unidentified']),
  },
  {
    metricCode: 'mkt.automations_blocked_failed', name: 'Automações bloqueadas e com falha', sourceReadModel: 'rm_mkt_automation', unit: 'COUNT', valueNature: 'ACTUAL', criticality: 'NORMAL', refreshPolicy: EVENT,
    description: 'Quantas execuções das automações de marketing houve no mês, quantas foram barradas e por quê, e quantas falharam.',
    formulaSemantic: 'No mês de São Paulo: execuções totais, bloqueadas (por blocked_reason; quiet hours não entra) e com falha (por código de erro), e o percentual de cada uma sobre o total (2 casas). Execução bloqueada sem motivo deixa o KPI DEGRADED.',
    dimensions: ['empresa', 'automação', 'motivo'], qualityRule: quality(['executed', 'blocked_without_reason', 'blocked_by_reason', 'failed_by_code']),
  },
]);

module.exports = { DEFINITIONS };
