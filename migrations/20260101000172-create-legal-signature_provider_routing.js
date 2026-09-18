'use strict';

/**
 * legal.signature_provider_routing — tabela de ROTEAMENTO, não de dado de negócio.
 *
 * Problema que resolve: o webhook público de um provedor de assinatura real (Clicksign/
 * ZapSign) chega SEM JWT de usuário — é o provedor externo chamando um endpoint público, não
 * uma ação de um usuário autenticado do sistema. Para aplicar RLS (SET LOCAL app.group_id/
 * app.company_id) antes de tocar qualquer dado de negócio, o handler do webhook precisa
 * primeiro DESCOBRIR de qual tenant é aquele evento — mas sem contexto de tenant ainda
 * resolvido, nenhuma tabela com policy `tenant_isolation` pode ser consultada (mesmo problema
 * de bootstrap já resolvido para login em auth.service.js, mas ali existe um JWT com
 * app.user_id para apoiar uma policy de self-lookup; aqui não existe usuário nenhum).
 *
 * Esta tabela é a exceção mínima e deliberada: guarda APENAS ids opacos do provedor (nunca
 * conteúdo de contrato/pessoa) mapeados para group_id/company_id, SEM RLS habilitado —
 * consultável sem nenhum contexto de tenant prévio. `initiateSignature` grava uma linha aqui
 * no mesmo instante em que cria cada `legal.signatures` (mesma transação/tenant), e o handler
 * do webhook público faz a ÚNICA leitura sem tenant deste fluxo inteiro, só para resolver
 * group_id/company_id — a partir daí toda leitura/escrita de negócio volta a rodar sob RLS
 * normal (SET LOCAL com os valores encontrados aqui).
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable(
      { tableName: 'signature_provider_routing', schema: 'legal' },
      {
        id: {
          type: Sequelize.UUID,
          defaultValue: Sequelize.literal('gen_random_uuid()'),
          primaryKey: true,
        },
        external_signature_id: { type: Sequelize.STRING, allowNull: false, unique: true },
        provider_envelope_id: { type: Sequelize.STRING, allowNull: true },
        group_id: { type: Sequelize.UUID, allowNull: false },
        company_id: { type: Sequelize.UUID, allowNull: false },
        created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('now()') },
      }
    );
    await queryInterface.addIndex(
      { tableName: 'signature_provider_routing', schema: 'legal' },
      ['provider_envelope_id'],
      { name: 'signature_provider_routing_envelope_idx' }
    );
    // Deliberadamente SEM ENABLE ROW LEVEL SECURITY — ver comentário acima do módulo.
  },

  down: async (queryInterface) => {
    await queryInterface.dropTable({ tableName: 'signature_provider_routing', schema: 'legal' });
  },
};
