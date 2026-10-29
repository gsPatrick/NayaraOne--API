'use strict';

// M9-D712 (3.3) — linhas da tabela de criticidade (centroComando). Cada linha: código, nome, demanda dona, criticidade explícita, domínio, unidade,
// natureza do valor (M9-D610), read model de origem, owner, dimensões e política de atualização, como escritos na demanda de KPI.

const ROWS = [
  { code: 'fin.approvals_pending', name: 'Aprovações financeiras pendentes', demand: 'M9-D709', criticality: 'CRITICAL', domain: 'FINANCE', unit: 'COUNT', valueNature: 'ACTUAL', sourceReadModel: 'rm_decision_queue', ownerRole: 'financeiro-gestor', dimensions: ['empresa', 'tipo de aprovação', 'solicitante', 'alçada'], refreshPolicy: { mode: 'SCHEDULE', cron: '*/15 * * * *', maxStalenessMinutes: 15 }, reason: 'exige decisão (bloco 2)' },
  { code: 'inv.adjustments_pending', name: 'Propostas de ajuste de estoque pendentes', demand: 'M9-D709', criticality: 'CRITICAL', domain: 'INVENTORY', unit: 'COUNT', valueNature: 'ACTUAL', sourceReadModel: 'rm_decision_queue', ownerRole: 'estoque-gestor', dimensions: ['empresa', 'depósito', 'motivo'], refreshPolicy: { mode: 'EVENT', maxStalenessMinutes: 15 }, reason: 'exige decisão (bloco 2)' },
  { code: 'tec.rule_approvals_pending', name: 'Aprovações de regra pendentes', demand: 'M9-D709', criticality: 'CRITICAL', domain: 'TECH_AI', unit: 'COUNT', valueNature: 'ACTUAL', sourceReadModel: 'rm_decision_queue', ownerRole: 'tecnologia-gestor', dimensions: ['empresa', 'regra', 'solicitante'], refreshPolicy: { mode: 'EVENT', maxStalenessMinutes: 15 }, reason: 'exige decisão (bloco 2)' },
  { code: 'ai.proposals_pending', name: 'Propostas da NAY aguardando aprovação humana', demand: 'M9-D709', criticality: 'CRITICAL', domain: 'TECH_AI', unit: 'COUNT', valueNature: 'ACTUAL', sourceReadModel: 'rm_decision_queue', ownerRole: 'ia-gestor', dimensions: ['empresa', 'agente', 'tipo de proposta'], refreshPolicy: { mode: 'EVENT', maxStalenessMinutes: 15 }, reason: 'exige decisão (bloco 2)' },
  { code: 'legal.contracts_signed', name: 'Contratos assinados na janela', demand: 'M9-D710', criticality: 'CRITICAL', domain: 'LEGAL', unit: 'COUNT', valueNature: 'ACTUAL', sourceReadModel: 'rm_command_events', ownerRole: 'juridico-gestor', dimensions: ['empresa', 'tipo de contrato'], refreshPolicy: { mode: 'EVENT', maxStalenessMinutes: 15 }, reason: 'o que aconteceu (bloco 1)' },
  { code: 'crm.opportunities_won', name: 'Oportunidades ganhas na janela', demand: 'M9-D710', criticality: 'CRITICAL', domain: 'CRM', unit: 'COUNT', valueNature: 'ACTUAL', sourceReadModel: 'rm_command_events', ownerRole: 'comercial-gestor', dimensions: ['empresa', 'corretor', 'origem'], refreshPolicy: { mode: 'EVENT', maxStalenessMinutes: 15 }, reason: 'o que aconteceu (bloco 1)' },
  { code: 'fin.payments_settled_relevant', name: 'Pagamentos liquidados acima do valor relevante', demand: 'M9-D710', criticality: 'CRITICAL', domain: 'FINANCE', unit: 'COUNT', valueNature: 'ACTUAL', sourceReadModel: 'rm_command_events', ownerRole: 'financeiro-gestor', dimensions: ['empresa', 'conta', 'terceiro sim/não'], refreshPolicy: { mode: 'EVENT', maxStalenessMinutes: 15 }, reason: 'o que aconteceu (bloco 1)' },
];

module.exports = { ROWS };
