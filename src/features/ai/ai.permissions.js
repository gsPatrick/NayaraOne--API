'use strict';

/**
 * Catálogo fechado das 8 permissões da NAY (M9-D003). A migration 20260101000700 grava a mesma lista (cópia literal; o teste
 * m9d003 confere que os códigos coincidem). A permissão da NAY nunca soma com a do usuário: a efetiva é a interseção (D017).
 */
const AI_PERMISSIONS = Object.freeze([
  { code: 'ai:use', risk: 'LOW', description: 'Criar run e conversar com agente da NAY.' },
  { code: 'ai:read', risk: 'LOW', description: 'Ver os próprios runs e as recomendações da NAY dirigidas ao usuário.' },
  { code: 'ai:audit', risk: 'MEDIUM', description: 'Ver runs, fontes e tool calls da NAY de toda a empresa.' },
  { code: 'ai:approve', risk: 'HIGH', description: 'Aceitar ou rejeitar recomendação da NAY (além da permissão da ação alvo).' },
  { code: 'ai:admin', risk: 'CRITICAL', description: 'Administrar agentes, tools, providers, base de conhecimento e a chave geral da NAY.' },
  { code: 'ai:budget', risk: 'HIGH', description: 'Editar os orçamentos de uso da NAY.' },
  { code: 'ai:evaluate', risk: 'MEDIUM', description: 'Rodar avaliações e homologar versões da NAY.' },
  { code: 'ai:restricted', risk: 'CRITICAL', description: 'Permitir que conteúdo RESTRICTED entre no contexto da NAY.' },
]);

const AI_PERMISSION_CODES = AI_PERMISSIONS.map((p) => p.code);

module.exports = { AI_PERMISSIONS, AI_PERMISSION_CODES };
