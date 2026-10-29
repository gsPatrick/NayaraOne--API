'use strict';

/**
 * M9-D680 — definição, no Metric Registry, dos seis KPIs de Tecnologia. Os 15 campos do livro (M9-D603): fonte (o read model de cada KPI), fórmula versionada no código
 * (formulas/tech*.js, id = código do indicador), dimensões, unidade, owner (parâmetro analytics.owner.<código>, padrão "Tecnologia (papel ti-gestor)"), política de atualização
 * (a da tabela de criticidade da M9-D712) e regra de qualidade, como escritos na demanda. Versão 1. Só tec.integration_errors é CRITICAL (nasce com drill-down).
 */
const REFERENCE_REPORT = 'Relatório de conciliação de KPIs de Tecnologia (M9-D708): sondas, filas, integrações, freshness, autenticação e bloqueios conforme a saúde do ERP';
const every = (cron, maxStalenessMinutes) => Object.freeze({ mode: 'SCHEDULE', cron, maxStalenessMinutes });
const EVENT = Object.freeze({ mode: 'EVENT', maxStalenessMinutes: 15 });
const quality = (maxStalenessMinutes, requiredFields) => ({ referenceReport: REFERENCE_REPORT, maxStalenessMinutes, requiredFields, allowNull: true });

const DEFINITIONS = Object.freeze([
  {
    metricCode: 'tec.availability', name: 'Disponibilidade', sourceReadModel: 'rm_tech_availability', unit: 'PERCENT', valueNature: 'ACTUAL', criticality: 'NORMAL', refreshPolicy: every('* * * * *', 1),
    description: 'Quanto do tempo o ERP esteve de pé no mês, medido por sondas de saúde (API, banco, fila e storage) a cada minuto, e quantos minutos ficou fora do ar.',
    formulaSemantic: 'Disponibilidade = sondas com sucesso ÷ sondas esperadas no mês de São Paulo × 100, arredondada uma vez para 2 casas (3 casas em details). Sonda ausente não conta como sucesso: entra em details.missingProbes. Minutos fora do ar = sondas falhas × intervalo. Mais de 5% de sondas ausentes deixa o KPI DEGRADED.',
    dimensions: ['serviço', 'período'], qualityRule: quality(1, ['checks', 'up', 'expected']),
  },
  {
    metricCode: 'tec.queues_dlq', name: 'Filas e DLQ', sourceReadModel: 'rm_tech_queues', unit: 'COUNT', valueNature: 'ACTUAL', criticality: 'NORMAL', refreshPolicy: every('*/5 * * * *', 5),
    description: 'Quantos itens aguardam nas filas do ERP (outbox e inbox), há quantos segundos o mais antigo espera e quantos esgotaram as tentativas (DLQ).',
    formulaSemantic: 'Por fila e tipo de evento: profundidade (itens aguardando, o valor), idade em segundos do item mais antigo e quantidade na DLQ. Fila sem medição há mais de 15 minutos fica STALE, com o valor da última medição.',
    dimensions: ['fila', 'tipo de evento'], qualityRule: quality(5, ['depth', 'oldest_at', 'dlq_depth']),
  },
  {
    metricCode: 'tec.integration_errors', name: 'Integrações com erro', sourceReadModel: 'rm_tech_integrations', unit: 'PERCENT', valueNature: 'ACTUAL', criticality: 'CRITICAL', drilldownEnabled: true, refreshPolicy: every('*/5 * * * *', 5),
    description: 'Que parte das chamadas às integrações falhou na última hora, por fornecedor, e quantos fornecedores passaram do limite de erro do SLO.',
    formulaSemantic: 'Na janela analytics.tec.janela_minutos (padrão 60): chamadas, erros e % de erro = erros ÷ chamadas × 100 (2 casas, uma vez) por fornecedor e no total, e o número de fornecedores acima do limiar de erro do SLO do Bloco B. Sem chamadas na janela o KPI fica INCOMPLETE. Os 9 valores de saúde de cada fornecedor, ambiente e família vão em details.byProvider.',
    dimensions: ['provider', 'conexão', 'família', 'ambiente'], qualityRule: quality(5, ['calls', 'errors', 'error_limit_pct']),
  },
  {
    metricCode: 'tec.freshness', name: 'Freshness dos dados do BI', sourceReadModel: 'rm_tech_freshness', unit: 'COUNT', valueNature: 'ACTUAL', criticality: 'NORMAL', refreshPolicy: every('*/5 * * * *', 5),
    description: 'Quantos read models do BI estão desatualizados (STALE ou EXPIRED) e qual o pior, com a idade em minutos.',
    formulaSemantic: 'Por read model, idade em minutos do source_snapshot_at da última atualização bem-sucedida e o estado FRESH, STALE ou EXPIRED (M9-D609). O valor é o número de read models STALE ou EXPIRED; o pior vai em details.worst. Sem registro de atualização o KPI fica INCOMPLETE.',
    dimensions: ['read model'], qualityRule: quality(5, ['last_snapshot_at', 'max_age_minutes', 'state']),
  },
  {
    metricCode: 'tec.auth_failures', name: 'Falhas de autenticação', sourceReadModel: 'rm_tech_auth_failures', unit: 'COUNT', valueNature: 'ACTUAL', criticality: 'NORMAL', refreshPolicy: EVENT,
    description: 'Quantas falhas de login, de MFA e de autenticação de integração (credencial expirada ou revogada) houve no dia, com os picos por hora acima do limiar.',
    formulaSemantic: 'No dia-base de São Paulo: contagem de falhas de login, de MFA e de integração, com os atores distintos (por hash, sem identificar ninguém) e o pico por hora; pico acima de analytics.tec.auth_falhas_por_hora (padrão 20) liga details.alert. Sem log de autenticação o KPI fica INCOMPLETE.',
    dimensions: ['tipo', 'provider'], qualityRule: quality(15, ['failures', 'distinct_actors', 'peak_hour_failures']),
  },
  {
    metricCode: 'tec.blocked_events', name: 'Eventos bloqueados', sourceReadModel: 'rm_tech_blocked_events', unit: 'COUNT', valueNature: 'ACTUAL', criticality: 'NORMAL', refreshPolicy: EVENT,
    description: 'Quantos eventos foram barrados no dia, por motivo (kill switch, política de segurança, falta de consentimento, validação).',
    formulaSemantic: 'Contagem de eventos bloqueados no dia-base de São Paulo por motivo; motivos desconhecidos somam em details.other. Evento bloqueado sem motivo deixa o KPI DEGRADED.',
    dimensions: ['motivo', 'tipo de evento'], qualityRule: quality(15, ['reason', 'blocked']),
  },
]);

module.exports = { DEFINITIONS };
