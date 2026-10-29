'use strict';

// M9-D712 (3.3) — linhas da tabela de criticidade (tecnologiaIa). Cada linha: código, nome, demanda dona, criticidade explícita, domínio, unidade,
// natureza do valor (M9-D610), read model de origem, owner, dimensões e política de atualização, como escritos na demanda de KPI.
const { NORMAL_WHY } = require('./criticality.constants');

const ROWS = [
  { code: 'tec.availability', name: 'Disponibilidade', demand: 'M9-D680', criticality: 'NORMAL', domain: 'TECH_AI', unit: 'PERCENT', valueNature: 'ACTUAL', sourceReadModel: 'rm_tech_availability', ownerRole: 'ti-gestor', dimensions: ['serviço', 'período'], refreshPolicy: { mode: 'SCHEDULE', cron: '* * * * *', maxStalenessMinutes: 1 }, reason: NORMAL_WHY },
  { code: 'tec.queues_dlq', name: 'Filas e DLQ', demand: 'M9-D680', criticality: 'NORMAL', domain: 'TECH_AI', unit: 'COUNT', valueNature: 'ACTUAL', sourceReadModel: 'rm_tech_queues', ownerRole: 'ti-gestor', dimensions: ['fila', 'tipo de evento'], refreshPolicy: { mode: 'SCHEDULE', cron: '*/5 * * * *', maxStalenessMinutes: 5 }, reason: NORMAL_WHY },
  { code: 'tec.integration_errors', name: 'Integrações com erro', demand: 'M9-D680', criticality: 'CRITICAL', domain: 'TECH_AI', unit: 'PERCENT', valueNature: 'ACTUAL', sourceReadModel: 'rm_tech_integrations', ownerRole: 'ti-gestor', dimensions: ['provider', 'conexão', 'família', 'ambiente'], refreshPolicy: { mode: 'SCHEDULE', cron: '*/5 * * * *', maxStalenessMinutes: 5 }, reason: 'risco, integrações fora do SLO (bloco 3)' },
  { code: 'tec.freshness', name: 'Freshness dos dados do BI', demand: 'M9-D680', criticality: 'NORMAL', domain: 'TECH_AI', unit: 'COUNT', valueNature: 'ACTUAL', sourceReadModel: 'rm_tech_freshness', ownerRole: 'ti-gestor', dimensions: ['read model'], refreshPolicy: { mode: 'SCHEDULE', cron: '*/5 * * * *', maxStalenessMinutes: 5 }, reason: NORMAL_WHY },
  { code: 'tec.auth_failures', name: 'Falhas de autenticação', demand: 'M9-D680', criticality: 'NORMAL', domain: 'TECH_AI', unit: 'COUNT', valueNature: 'ACTUAL', sourceReadModel: 'rm_tech_auth_failures', ownerRole: 'ti-gestor', dimensions: ['tipo', 'provider'], refreshPolicy: { mode: 'EVENT', maxStalenessMinutes: 15 }, reason: NORMAL_WHY },
  { code: 'tec.blocked_events', name: 'Eventos bloqueados', demand: 'M9-D680', criticality: 'NORMAL', domain: 'TECH_AI', unit: 'COUNT', valueNature: 'ACTUAL', sourceReadModel: 'rm_tech_blocked_events', ownerRole: 'ti-gestor', dimensions: ['motivo', 'tipo de evento'], refreshPolicy: { mode: 'EVENT', maxStalenessMinutes: 15 }, reason: NORMAL_WHY },
  { code: 'ai.cost_by_agent', name: 'Custo de IA por agente', demand: 'M9-D681', criticality: 'NORMAL', domain: 'TECH_AI', unit: 'BRL', valueNature: 'ACTUAL', sourceReadModel: 'rm_ai_cost', ownerRole: 'ti-gestor', dimensions: ['empresa', 'agente', 'modelo'], refreshPolicy: { mode: 'EVENT', maxStalenessMinutes: 15 }, reason: NORMAL_WHY },
  { code: 'ai.quality_scores', name: 'Grounding e evaluation score', demand: 'M9-D681', criticality: 'NORMAL', domain: 'TECH_AI', unit: 'PERCENT', valueNature: 'ACTUAL', sourceReadModel: 'rm_ai_quality', ownerRole: 'ti-gestor', dimensions: ['empresa', 'agente', 'semana'], refreshPolicy: { mode: 'SCHEDULE', cron: '0 3 * * 1', maxStalenessMinutes: 10080 }, reason: NORMAL_WHY },
  { code: 'ai.budget', name: 'Budget de IA', demand: 'M9-D681', criticality: 'NORMAL', domain: 'TECH_AI', unit: 'PERCENT', valueNature: 'ACTUAL', sourceReadModel: 'rm_ai_cost', ownerRole: 'ti-gestor', dimensions: ['empresa', 'agente'], refreshPolicy: { mode: 'EVENT', maxStalenessMinutes: 15 }, reason: NORMAL_WHY },
  { code: 'ai.tool_calls_blocked', name: 'Tool calls bloqueadas', demand: 'M9-D681', criticality: 'NORMAL', domain: 'TECH_AI', unit: 'COUNT', valueNature: 'ACTUAL', sourceReadModel: 'rm_ai_tool_calls', ownerRole: 'ti-gestor', dimensions: ['empresa', 'agente', 'ferramenta', 'motivo'], refreshPolicy: { mode: 'EVENT', maxStalenessMinutes: 15 }, reason: NORMAL_WHY },
];

module.exports = { ROWS };
