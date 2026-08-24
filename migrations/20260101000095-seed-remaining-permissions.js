'use strict';

const { randomUUID } = require('crypto');

/**
 * Migration: completa o catálogo "core"."permissions" com as strings de todos os módulos que
 * ainda não tinham sido semeados (só "legal:*" tinha, via 20260101000092). Lista extraída via
 * grep de requirePermission(...) em todos os *.routes.js — é a fonte de verdade das
 * permissões que o sistema já reconhece em runtime (o JWT já carrega essas strings desde o
 * login; o que faltava era só o registro no catálogo, necessário para a tela de administração
 * de papéis poder referenciar cada permissão por FK em core.role_permissions).
 */
const CODES = [
  // roles (administração de papéis e permissões — nova feature)
  ['roles:create', 'Criar papéis (roles) e definir suas permissões.', 'CRITICAL'],
  ['roles:read', 'Consultar papéis, suas permissões e o catálogo de permissões do sistema.', 'LOW'],
  ['roles:update', 'Editar papéis existentes (nome, descrição, permissões).', 'CRITICAL'],
  ['roles:delete', 'Excluir papéis.', 'CRITICAL'],
  // companies
  ['companies:create', 'Cadastrar empresas.', 'MEDIUM'],
  ['companies:read', 'Consultar empresas.', 'LOW'],
  ['companies:update', 'Editar dados de empresas.', 'MEDIUM'],
  ['companies:delete', 'Excluir empresas.', 'HIGH'],
  // groups
  ['groups:create', 'Cadastrar grupos econômicos.', 'HIGH'],
  ['groups:read', 'Consultar grupos econômicos.', 'LOW'],
  ['groups:update', 'Editar grupos econômicos.', 'HIGH'],
  ['groups:delete', 'Excluir grupos econômicos.', 'CRITICAL'],
  // units
  ['units:create', 'Cadastrar unidades/filiais.', 'MEDIUM'],
  ['units:read', 'Consultar unidades/filiais.', 'LOW'],
  ['units:update', 'Editar unidades/filiais.', 'MEDIUM'],
  ['units:delete', 'Excluir unidades/filiais.', 'HIGH'],
  // users
  ['users:create', 'Cadastrar usuários do sistema.', 'HIGH'],
  ['users:read', 'Consultar usuários do sistema.', 'LOW'],
  ['users:update', 'Editar usuários do sistema.', 'HIGH'],
  ['users:delete', 'Excluir usuários do sistema.', 'CRITICAL'],
  // memberships
  ['memberships:create', 'Vincular usuário a uma empresa/papel (conceder acesso).', 'HIGH'],
  ['memberships:read', 'Consultar vínculos de usuário/empresa/papel e permissões efetivas.', 'LOW'],
  ['memberships:delete', 'Revogar vínculo de usuário a uma empresa (remover acesso).', 'HIGH'],
  // people
  ['people:create', 'Cadastrar pessoas (contatos, clientes, fiadores etc).', 'MEDIUM'],
  ['people:read', 'Consultar pessoas cadastradas.', 'LOW'],
  ['people:update', 'Editar dados de pessoas cadastradas.', 'MEDIUM'],
  ['people:delete', 'Excluir pessoas cadastradas.', 'HIGH'],
  // properties
  ['properties:create', 'Cadastrar imóveis.', 'MEDIUM'],
  ['properties:read', 'Consultar imóveis.', 'LOW'],
  ['properties:update', 'Editar imóveis (anúncio, mídia, documentos, proprietários, ofertas).', 'MEDIUM'],
  ['properties:delete', 'Excluir imóveis.', 'HIGH'],
  ['properties:internal', 'Ver e registrar ocorrências internas do imóvel (uso restrito da equipe).', 'MEDIUM'],
  // crm
  ['crm:opportunities:create', 'Criar oportunidades no funil de vendas/locação.', 'MEDIUM'],
  ['crm:opportunities:read', 'Consultar oportunidades do funil.', 'LOW'],
  ['crm:opportunities:update', 'Editar/mover oportunidades entre etapas do funil.', 'MEDIUM'],
  ['crm:opportunities:delete', 'Excluir oportunidades do funil.', 'HIGH'],
  ['crm:visits:create', 'Agendar visitas a imóveis.', 'MEDIUM'],
  ['crm:visits:read', 'Consultar visitas agendadas.', 'LOW'],
  ['crm:visits:update', 'Editar/atualizar status de visitas.', 'MEDIUM'],
  ['crm:visits:delete', 'Excluir visitas.', 'MEDIUM'],
  ['crm:messages:create', 'Registrar mensagens trocadas com clientes/leads.', 'MEDIUM'],
  ['crm:messages:read', 'Consultar histórico de mensagens.', 'LOW'],
  ['crm:messages:update', 'Atualizar status de mensagens.', 'MEDIUM'],
  // radar
  ['radar:create', 'Criar radares de busca de imóveis para clientes.', 'MEDIUM'],
  ['radar:read', 'Consultar radares e seus matches.', 'LOW'],
  ['radar:update', 'Editar critérios de um radar.', 'MEDIUM'],
  ['radar:delete', 'Excluir radares.', 'MEDIUM'],
  // finance
  ['finance:create', 'Criar lançamentos, contas bancárias, comissões e repasses financeiros.', 'HIGH'],
  ['finance:read', 'Consultar dados financeiros (lançamentos, contas, comissões, repasses).', 'LOW'],
  ['finance:update', 'Editar dados financeiros enquanto pendentes.', 'HIGH'],
  ['finance:settle', 'Liquidar/estornar lançamentos e pagar comissões/repasses.', 'CRITICAL'],
  ['finance:reconcile', 'Conciliar lançamentos com o extrato bancário.', 'HIGH'],
  ['finance:approve', 'Aprovar solicitações financeiras (maker-checker).', 'CRITICAL'],
  ['finance:bankAccounts', 'Cadastrar, editar e bloquear contas bancárias (dado sensível/antifraude).', 'CRITICAL'],
];

module.exports = {
  up: async (queryInterface) => {
    const now = new Date();
    const rows = CODES.map(([code, description, riskLevel]) => ({
      id: randomUUID(),
      code,
      description,
      risk_level: riskLevel,
      created_at: now,
      updated_at: now,
    }));

    await queryInterface.bulkInsert({ tableName: 'permissions', schema: 'core' }, rows, {
      ignoreDuplicates: true,
    });
  },

  down: async (queryInterface) => {
    await queryInterface.bulkDelete(
      { tableName: 'permissions', schema: 'core' },
      { code: CODES.map(([code]) => code) }
    );
  },
};
