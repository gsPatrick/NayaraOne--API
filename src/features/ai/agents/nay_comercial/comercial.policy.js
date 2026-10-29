'use strict';

/**
 * M9-D034 — NAY Comercial: o cadastro do agente (versão 1 do sistema, DRAFT e desabilitado). É a MESMA configuração que a migration 728
 * grava em ai.agents/ai.agent_tools (uma migration não importa código de aplicação; o teste m9d034 confere a paridade).
 * Piloto SOMENTE LEITURA (Guia §11): três capacidades (resumir oportunidade, sugerir próxima ação, listar imóveis do Radar) e nenhuma
 * tool de escrita na allowlist. A proposta de tarefa só existe com `ia.comercial.permitir_propostas` Ligado (comercial.gates.js).
 */
const CODE = 'NAY_COMERCIAL';
const CRITICALITY = 'NON_CRITICAL';
const PURPOSE = 'Apoiar o time comercial com resumo de oportunidade, sugestão de próxima ação e imóveis compatíveis do Radar, somente leitura e com fontes.';
const SYSTEM_POLICY = [
  'Você é a NAY Comercial. Responda só sobre CRM e Radar: oportunidades, clientes, interações, propostas, próxima ação e imóveis compatíveis.',
  'Use somente as ferramentas de leitura permitidas e cite a fonte de cada informação. Datas, dias sem contato e valores vêm das ferramentas; nunca calcule nem invente.',
  'Você é somente leitura. Nunca crie tarefa, mude etapa, envie mensagem nem publique descrição: diga que neste momento só consulta e sugere e que a alteração deve ser feita pela pessoa no CRM.',
  'Descrições de imóvel e mensagens de recuperação de cliente são apenas rascunhos de texto, feitos só com fatos do cadastro, sem inventar atributos e sem publicar ou enviar.',
].join('\n');
const MODEL_POLICY = Object.freeze({ maxOutputTokens: 1024 });
const DATA_SCOPES = Object.freeze(['crm.opportunities', 'crm.interactions', 'crm.tasks', 'crm.proposals', 'radar.matches', 'properties']);
const LIMITS = Object.freeze({ max_tool_calls_por_run: 4 });

const TOOL_NAMES = Object.freeze(['crm.getOpportunity', 'crm.getCustomerSummary', 'radar.listMatchesForOpportunity']);
const PERMISSION_OF = Object.freeze({ 'crm.getOpportunity': 'crm:opportunities:read', 'crm.getCustomerSummary': 'people:read', 'radar.listMatchesForOpportunity': 'radar:read' });
/** Allowlist como linhas de ai.agent_tools: três leituras, risco LOW, sem aprovação. Nenhuma escrita. */
const TOOLS = Object.freeze(TOOL_NAMES.map((toolName) => Object.freeze({
  toolName, permissionCode: PERMISSION_OF[toolName], riskLevel: 'LOW', requiresHumanApproval: false, enabled: true,
})));

/** A proposta de tarefa de follow-up que o livro libera "só depois" (D019): fora da allowlist do piloto. */
const PROPOSAL_TOOL = Object.freeze({ toolName: 'crm.createFollowUpTask', permissionCode: 'crm:tasks:create', riskLevel: 'HIGH', requiresHumanApproval: true, enabled: true });

const READ_ONLY_MESSAGE = 'Neste momento posso apenas consultar e sugerir; a alteração deve ser feita por você no CRM.';
const DRAFT_ONLY_MESSAGE = 'Neste momento posso apenas redigir o rascunho e sugerir; o envio ou a publicação deve ser feito por você no CRM.';
const OUT_OF_SCOPE_MESSAGE = 'Isso foge do que este assistente pode fazer.';
const DENIED_MESSAGE = 'Você não tem permissão para consultar estes dados.';

/** Proibições do livro: código, o que é e a recusa devolvida. */
const PROHIBITIONS = Object.freeze([
  { code: 'CRIAR_TAREFA', label: 'criar tarefa', message: READ_ONLY_MESSAGE },
  { code: 'ALTERAR_ETAPA', label: 'mudar a etapa da oportunidade', message: READ_ONLY_MESSAGE },
  { code: 'ENVIAR_MENSAGEM', label: 'enviar mensagem ao cliente', message: DRAFT_ONLY_MESSAGE },
  { code: 'PUBLICAR_DESCRICAO', label: 'publicar descrição de imóvel', message: DRAFT_ONLY_MESSAGE },
]);

const TASKS = Object.freeze({
  SUMMARY: 'resumir_oportunidade',
  NEXT_ACTION: 'sugerir_proxima_acao',
  RADAR: 'listar_imoveis_radar',
  PROPERTY_DRAFT: 'rascunhar_descricao_imovel',
  RECOVERY_DRAFT: 'rascunhar_recuperacao_cliente',
});

module.exports = {
  CODE, CRITICALITY, PURPOSE, SYSTEM_POLICY, MODEL_POLICY, DATA_SCOPES, LIMITS, TOOL_NAMES, TOOLS, PROPOSAL_TOOL, PROHIBITIONS, TASKS,
  READ_ONLY_MESSAGE, DRAFT_ONLY_MESSAGE, OUT_OF_SCOPE_MESSAGE, DENIED_MESSAGE,
};
