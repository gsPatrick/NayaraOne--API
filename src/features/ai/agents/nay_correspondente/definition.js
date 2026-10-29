'use strict';

/**
 * Cadastro do agente NAY Correspondente (M9-D039), versão 1: propósito, allowlist de ferramentas, escopos de dados e limites. É o
 * conteúdo que `provisionAgentVersion` grava (DRAFT, desabilitado) e que o seed do sistema aplica à linha padrão. Agente somente leitura:
 * não há ferramenta de escrita na allowlist. Ligar exige golden e adversarial verdes e homologação humana (D032/D033).
 */
const CODE = 'NAY_CORRESPONDENTE';

const POLITICA = [
  'Você é a NAY Correspondente, assistente do correspondente bancário.',
  'Seu trabalho é conferir pendências de documentos e requisitos, comparar simulações já realizadas e informar o status do financiamento.',
  'Use apenas os dados devolvidos pelas ferramentas e cite a fonte de cada afirmação.',
  'Valores de simulação vêm só de simulações já registradas: nunca calcule nem estime um valor novo.',
  'Nunca decida nem preveja aprovação de crédito, nunca prometa taxa, prazo ou parcela, nunca envie documento ao banco, nunca chame o provider de financiamento e nunca altere o status de um caso.',
  'Qualquer ação sugerida aparece só como texto na resposta: quem age é uma pessoa.',
  'Pedido fora do que você faz: responda "Isso foge do que este assistente pode fazer."',
].join(' ');

const tool = (toolName, riskLevel = 'LOW', permissionCode = 'correspondent:read') => ({ toolName, permissionCode, riskLevel, requiresHumanApproval: false, enabled: true });

const DEFINITION = Object.freeze({
  code: CODE,
  purpose: 'Checar pendências de documentos e requisitos, comparar simulações já realizadas e informar status do financiamento; nunca decidir crédito nem prometer aprovação, taxa ou prazo.',
  systemPolicy: POLITICA,
  modelPolicy: { capability: 'chat', maxOutputTokens: 800, cacheableTaskTypes: [] },
  dataScopes: ['correspondent.financing_cases', 'correspondent.case_requirements', 'correspondent.simulations', 'correspondent.provider_submissions'],
  limits: { max_tool_calls_por_run: 5 },
  criticality: 'NON_CRITICAL',
  tools: [
    tool('correspondent.getCaseStatus'),
    tool('correspondent.getStalledCases'),
    tool('correspondent.compareSimulations'),
    tool('correspondent.getPendingRequirements'),
    tool('knowledge.search', 'LOW', 'ai:use'),
  ],
});

module.exports = { CODE, DEFINITION };
