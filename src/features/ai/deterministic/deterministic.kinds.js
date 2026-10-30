'use strict';

/**
 * Os caminhos determinísticos da IA (Marco 9, M9-D228 3.2, modo DEGRADE_TO_DETERMINISTIC). Cada função com IA tem UM equivalente que não depende de modelo:
 *  - READ_SERVICE: a leitura do próprio ERP (os mesmos serviços da tool), devolvida como dado e tabela, sem texto gerado;
 *  - RULE_ENGINE: as regras do Motor de Regras e dos indicadores no lugar de recomendação ou análise por modelo;
 *  - KEYWORD_SEARCH: busca por palavras-chave (texto) no lugar da busca semântica;
 *  - FILTER: filtros de nome e tipo no lugar da classificação por modelo;
 *  - PREDEFINED_TEMPLATE: modelos de texto pré-definidos (modelos de contrato) no lugar de redação por modelo;
 *  - HUMAN_FORM: o formulário da tela normal, que a pessoa preenche, no lugar da ação proposta pela IA (toda ação de negócio exige aprovação humana de qualquer forma).
 */
const KINDS = Object.freeze(['READ_SERVICE', 'RULE_ENGINE', 'KEYWORD_SEARCH', 'FILTER', 'PREDEFINED_TEMPLATE', 'HUMAN_FORM']);

module.exports = { KINDS };
