'use strict';

const { KINDS } = require('./deterministic.kinds');

const por = (kind, equivalent) => Object.freeze({ kind, equivalent });

/**
 * Catálogo das funções com IA do ERP e do caminho determinístico equivalente de cada uma (M9-D228 critério 2). Toda tool registrada na NAY e todo agente do sistema
 * precisa estar aqui (o teste de cobertura reprova função nova sem caminho declarado). Nenhuma ação de negócio depende só da resposta da IA.
 */
const TOOLS = Object.freeze({
  'construction.getBudgetVsActual': por('READ_SERVICE', 'Orçado x realizado da obra lido direto do cadastro de obras.'),
  'construction.getDailyReports': por('READ_SERVICE', 'Diários de obra listados do cadastro.'),
  'construction.getPortfolioProgress': por('READ_SERVICE', 'Avanço da carteira de obras lido dos indicadores.'),
  'construction.getProjectProgress': por('READ_SERVICE', 'Avanço da obra lido do cadastro.'),
  'construction.getQualityNonConformities': por('READ_SERVICE', 'Não conformidades de qualidade listadas do cadastro.'),
  'construction.getWarrantyCases': por('READ_SERVICE', 'Casos de garantia listados do cadastro.'),
  'correspondent.compareSimulations': por('RULE_ENGINE', 'Comparação das simulações pelas regras de taxa, prazo e parcela do Correspondente.'),
  'correspondent.getCaseStatus': por('READ_SERVICE', 'Situação do caso lida do cadastro do Correspondente.'),
  'correspondent.getPendingRequirements': por('RULE_ENGINE', 'Pendências do caso pelas regras do checklist de documentos.'),
  'correspondent.getStalledCases': por('RULE_ENGINE', 'Casos parados pelas regras de prazo sem andamento.'),
  'crm.createFollowUpTask': por('HUMAN_FORM', 'Formulário da tela de tarefas do CRM, preenchido pela pessoa.'),
  'crm.createHandoffTask': por('HUMAN_FORM', 'Formulário de encaminhamento ao atendimento humano.'),
  'crm.getCustomerContactStatus': por('READ_SERVICE', 'Situação do contato lida do histórico do CRM.'),
  'crm.getCustomerSummary': por('READ_SERVICE', 'Resumo do cliente lido do cadastro de pessoas.'),
  'crm.getOpportunity': por('READ_SERVICE', 'Oportunidade lida do funil do CRM.'),
  'crm.getPipelineSummary': por('READ_SERVICE', 'Resumo do funil por etapa, calculado dos dados.'),
  'documents.checkConsistency': por('RULE_ENGINE', 'Conferência dos campos extraídos pelas regras de formato e de cruzamento do cadastro.'),
  'documents.classifySuggest': por('FILTER', 'Classificação do documento por filtros de nome e tipo do arquivo.'),
  'documents.extractFields': por('RULE_ENGINE', 'Extração por regras de formato (CPF, valores, datas) sobre o texto já transcrito.'),
  'documents.transcribe': por('HUMAN_FORM', 'Transcrição manual do documento pela pessoa, no formulário do tipo.'),
  'finance.getAnomalies': por('RULE_ENGINE', 'Anomalias financeiras pelas regras do Motor de Regras.'),
  'finance.getCashflowProjection': por('RULE_ENGINE', 'Projeção do caixa pelas regras de vencimento e recorrência.'),
  'finance.getDelinquency': por('READ_SERVICE', 'Inadimplência lida dos recebíveis vencidos.'),
  'finance.getWeeklyHealth': por('RULE_ENGINE', 'Saúde financeira da semana pelos indicadores.'),
  'finance.proposePayment': por('HUMAN_FORM', 'Intenção de pagamento criada pela pessoa na tela do Financeiro, com aprovação.'),
  'inventory.getStockRisks': por('RULE_ENGINE', 'Riscos de estoque pelas regras de nível mínimo e validade.'),
  'knowledge.search': por('KEYWORD_SEARCH', 'Busca por palavras-chave na base de conhecimento, no lugar da busca semântica.'),
  'legal.compareInspections': por('RULE_ENGINE', 'Comparação entrada x saída pelos itens pareados (ambiente + código), sem texto por modelo.'),
  'legal.compareVersions': por('READ_SERVICE', 'Comparação das versões do contrato linha a linha, sem resumo por modelo.'),
  'legal.draftContract': por('PREDEFINED_TEMPLATE', 'Modelos de contrato pré-definidos do tipo pedido, no lugar de redação por modelo.'),
  'legal.getContractSummary': por('READ_SERVICE', 'Dados do contrato lidos do cadastro do Jurídico.'),
  'legal.getDeadlines': por('READ_SERVICE', 'Prazos jurídicos listados do cadastro.'),
  'legal.getExpiringContracts': por('RULE_ENGINE', 'Contratos a vencer pelas regras de prazo.'),
  'legal.getRequirementsChecklist': por('RULE_ENGINE', 'Checklist de exigências pelas regras do tipo de contrato.'),
  'memory.recall': por('READ_SERVICE', 'Fatos da memória lidos por assunto, sem interpretação por modelo.'),
  'radar.listMatchesForOpportunity': por('RULE_ENGINE', 'Compatibilidade do Radar pelas regras de perfil e imóvel.'),
  'radar.listPublicListings': por('READ_SERVICE', 'Anúncios públicos listados do cadastro de imóveis.'),
});

const AGENTS = Object.freeze({
  NAY_ATENDIMENTO: por('FILTER', 'Triagem do atendimento por palavras e regras e encaminhamento à pessoa.'),
  NAY_COMERCIAL: por('RULE_ENGINE', 'Fila de ações comerciais pelas regras de prazo e etapa do funil.'),
  NAY_CORRESPONDENTE: por('RULE_ENGINE', 'Pendências e casos parados pelas regras do Correspondente.'),
  NAY_DIRETORIA: por('RULE_ENGINE', 'Indicadores e briefing pelos painéis do BI, sem texto gerado.'),
  NAY_DOCUMENTAL: por('FILTER', 'Classificação e conferência de documentos por filtros e regras de formato.'),
  NAY_FINANCEIRA: por('RULE_ENGINE', 'Alertas financeiros pelas regras do Motor de Regras.'),
  NAY_JURIDICA: por('PREDEFINED_TEMPLATE', 'Modelos de contrato e checklists pré-definidos.'),
  NAY_OBRAS: por('RULE_ENGINE', 'Alertas de obra pelas regras de custo, prazo e qualidade.'),
});

const RAG_SEARCH = por('KEYWORD_SEARCH', 'Busca por palavras-chave no índice, no lugar da busca semântica.');

/** Todas as entradas por identificador (`tool:<nome>`, `agent:<CÓDIGO>`, `rag.search`). */
const ENTRIES = Object.freeze({
  ...Object.fromEntries(Object.entries(TOOLS).map(([k, v]) => [`tool:${k}`, v])),
  ...Object.fromEntries(Object.entries(AGENTS).map(([k, v]) => [`agent:${k}`, v])),
  'rag.search': RAG_SEARCH,
});

const declaredFor = (id) => ENTRIES[id] || null;
const toolEntry = (name) => TOOLS[name] || null;

module.exports = { TOOLS, AGENTS, ENTRIES, declaredFor, toolEntry, KINDS };
