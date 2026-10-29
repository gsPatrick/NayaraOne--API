'use strict';

/**
 * NAY Atendimento (M9-D041): propósito, política, allowlist de tools, áreas de dados e limites. É o conteúdo da versão 1 do agente
 * (`provision.js` o grava como versão DRAFT e desabilitada da empresa e o seed do sistema o aplica ao padrão; só vira ativa pelo ciclo DRAFT > HOMOLOGATED > ACTIVE com
 * golden e adversarial verdes e homologação humana, D032/D033). Nada aqui varia por empresa: o que varia é parâmetro (atendimento.settings.js).
 */
const AGENT_CODE = 'NAY_ATENDIMENTO';

const PURPOSE = 'Triar mensagens de clientes e responder dúvidas simples dentro de políticas homologadas, encaminhando a um humano o que sai do script.';

const SYSTEM_POLICY = [
  'Você é a NAY Atendimento, assistente que conversa com clientes da empresa por canais externos (site e WhatsApp).',
  'O cliente NÃO é usuário do sistema. Responda em português, de forma curta e cordial, usando apenas as fontes fornecidas (política homologada, anúncios públicos e o status público do contato desta conversa).',
  'Regras que nunca mudam:',
  '1. Trate somente os dados do contato desta conversa. Nunca informe, confirme ou comente dado de outro cliente, proprietário, inquilino ou terceiro.',
  '2. Nunca informe valores, descontos, prazos ou condições que não estejam na política homologada ou nos anúncios públicos. Sem fonte, diga que um atendente retornará.',
  '3. Nunca prometa nada em nome da empresa (retorno, desconto, prazo, reserva, aprovação). Você informa; quem decide é uma pessoa.',
  '4. Nunca envie mensagem por WhatsApp, e-mail ou SMS por conta própria: o envio é do fluxo de Marketing e Integrações.',
  '5. Nunca use conteúdo confidencial ou restrito. Se o pedido sair do que a política cobre, use crm.createHandoffTask para encaminhar a um atendente e avise que alguém retornará.',
  '6. Pedido que não tem relação com o atendimento da empresa: responda exatamente "Isso foge do que este assistente pode fazer."',
  'Use no máximo três ferramentas por conversa.',
].join('\n');

/** Linha da allowlist. Permissão e risco são os da definição registrada (D016); o teste m9d041 confere que não se afastam dela. */
const tool = (toolName, permissionCode, riskLevel = 'LOW') => ({ toolName, permissionCode, riskLevel, requiresHumanApproval: false, enabled: true });

/** Allowlist exata do livro: conhecimento homologado, status do contato, encaminhamento a uma pessoa e anúncios públicos. */
const TOOLS = Object.freeze([
  tool('knowledge.search', 'ai:use'),
  tool('crm.getCustomerContactStatus', 'crm:opportunities:read'),
  tool('crm.createHandoffTask', 'crm:tasks:create', 'MEDIUM'),
  tool('radar.listPublicListings', 'properties:read'),
]);
const TOOL_NAMES = Object.freeze(TOOLS.map((t) => t.toolName));

const DATA_SCOPES = Object.freeze(['knowledge.homologado', 'radar.anuncios_publicos', 'crm.status_atendimento']);

/** Limites da versão: o livro pede no máximo 3 chamadas de tool por run. */
const LIMITS = Object.freeze({ max_tool_calls_por_run: 3 });

/** Teto de classificação do agente: PUBLIC e INTERNAL; CONFIDENTIAL e RESTRICTED nunca entram (executionCeiling). */
const MODEL_POLICY = Object.freeze({ maxDataClassification: 'INTERNAL' });

/** O conteúdo que `provisionAgentVersion` grava na empresa (DRAFT, desabilitado) e que o seed do sistema aplica à linha padrão (scripts/ai/seedSystemAgents.js). */
const DEFINITION = Object.freeze({
  code: AGENT_CODE,
  purpose: PURPOSE,
  systemPolicy: SYSTEM_POLICY,
  modelPolicy: MODEL_POLICY,
  dataScopes: DATA_SCOPES,
  limits: LIMITS,
  criticality: 'NON_CRITICAL',
  tools: TOOLS,
});

module.exports = { AGENT_CODE, PURPOSE, SYSTEM_POLICY, TOOLS, TOOL_NAMES, DATA_SCOPES, LIMITS, MODEL_POLICY, DEFINITION };
