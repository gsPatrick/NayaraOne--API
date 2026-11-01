'use strict';

/**
 * M9-D682/M9-D673 (reabertura F08) — nome em português de cada read model do BI. As linhas do quadro de freshness (e qualquer tela que liste uma fonte) mostram este
 * nome; o código técnico (rm_...) fica só no identificador da linha, nunca como texto. Read model sem entrada aqui cai em `readModelLabel` (humanização sem o prefixo)
 * e o teste m9d682 falha, para a lista acompanhar o registro.
 */
const LABELS = Object.freeze({
  rm_finance_cash: 'Caixa', rm_finance_health: 'Saúde financeira', rm_finance_sector_margin: 'Margem por setor', rm_finance_intercompany: 'Transferências entre empresas',
  rm_crm_lead_daily: 'Leads por dia', rm_crm_opportunity_stage: 'Oportunidades por estágio', rm_crm_outcome: 'Ganhos e perdas', rm_crm_next_action: 'Próximas ações do CRM',
  rm_crm_visits_proposals: 'Visitas e propostas', rm_property_portfolio: 'Carteira de imóveis', rm_property_price_changes: 'Mudanças de preço', rm_radar_matches: 'Combinações do radar',
  rm_broker_performance: 'Desempenho dos corretores', rm_rental_contracts: 'Contratos de locação', rm_rental_vacancy: 'Vacância', rm_rental_arrears: 'Inadimplência da locação',
  rm_rental_guarantees: 'Garantias de locação', rm_rental_obligations: 'Obrigações de locação', rm_rental_inspections_keys: 'Vistorias e chaves', rm_rental_tickets: 'Chamados de locação',
  rm_rental_satisfaction: 'Satisfação da locação', rm_rental_repasses: 'Repasses de locação', rm_project_progress: 'Andamento das obras', rm_project_cost: 'Custo das obras',
  rm_project_delays: 'Atrasos das obras', rm_project_measurements: 'Medições das obras', rm_project_nonconformities: 'Não conformidades das obras', rm_project_waste: 'Perdas das obras',
  rm_postwork_cost: 'Custo do pós-obra', rm_project_occurrences: 'Ocorrências das obras', rm_inventory_health: 'Saúde do estoque', rm_tool_assets: 'Ferramentas e patrimônio',
  rm_legal_deadlines: 'Prazos jurídicos', rm_legal_cases_risk: 'Risco dos casos jurídicos', rm_legal_values: 'Valores jurídicos', rm_legal_missing_docs: 'Documentos jurídicos faltantes',
  rm_fin_cases_stage: 'Financiamentos por estágio', rm_fin_provider_outcome: 'Resultado por banco', rm_fin_commission: 'Comissão do correspondente',
  rm_mkt_campaigns: 'Campanhas', rm_mkt_delivery: 'Entregabilidade', rm_mkt_frequency: 'Frequência de contato', rm_mkt_reviews: 'Reviews', rm_mkt_automation: 'Automações de marketing',
  rm_mkt_campaign_month: 'Campanhas do mês', rm_mkt_optout_month: 'Opt-out do mês', rm_support_satisfaction: 'Satisfação do atendimento', rm_support_complaints: 'Reclamações',
  rm_support_sla: 'SLA do atendimento', rm_tech_availability: 'Disponibilidade técnica', rm_tech_queues: 'Filas e DLQ', rm_tech_freshness: 'Atualização dos dados do BI',
  rm_tech_integrations: 'Saúde das integrações', rm_tech_blocked_events: 'Eventos bloqueados', rm_tech_auth_failures: 'Falhas de autenticação', rm_ai_cost: 'Custo de IA',
  rm_ai_quality: 'Qualidade da IA', rm_ai_tool_calls: 'Chamadas de ferramenta da IA', rm_decision_queue: 'Fila de decisões', rm_command_events: 'Eventos do Centro de Comando',
});

/** Nome em português do read model; sem entrada, o código sem o prefixo e sem sublinhado (nunca "Rm ..."). */
function readModelLabel(code) {
  const id = String(code);
  if (LABELS[id]) return LABELS[id];
  const text = id.replace(/^rm_/, '').replace(/_/g, ' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

module.exports = { readModelLabel, READ_MODEL_LABELS: LABELS };
