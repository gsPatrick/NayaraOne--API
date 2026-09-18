'use strict';

/**
 * Migration (M3-12): motivos ESTRUTURADOS de ganho, perda e desistência em
 * "crm"."opportunities".
 *
 * Antes existia só `lost_reason` TEXT livre, sem validação nenhuma — não dava pra agregar
 * "motivos de perda mais comuns" no painel (M3-17) porque cada corretor escrevia o motivo
 * com palavras diferentes.
 *
 * DECISÃO DE ENGENHARIA (não estava literalmente explicitada no Caderno CURRENT — Marco 3):
 *  - Os motivos viram um ENUM FECHADO validado na APLICAÇÃO
 *    (src/features/crm/opportunityOutcomeReason.validator.js), não um CHECK constraint no
 *    banco, pelo mesmo motivo já documentado em opportunityNextAction.validator.js: `stage`
 *    é string livre (funil configurável por tenant no futuro), então a regra "qual motivo é
 *    válido para qual desfecho" pertence à camada que conhece o funil. As colunas seguem
 *    STRING(32) pra permitir evoluir o enum sem migration de tipo.
 *  - "Desistência" é modelada como um novo STAGE `WITHDRAWN` (e não como um flag booleano
 *    separado), porque `stage` já é o campo que representa o estado terminal da oportunidade
 *    e porque isso mantém as listagens/painel com UMA única dimensão de estado. `WITHDRAWN`
 *    entra em CLOSED_STAGES (não exige nextAction e preenche closed_at), igual a
 *    CLOSED_WON/CLOSED_LOST.
 *  - `lost_reason` é REUTILIZADA (não recriada) para o motivo de LOST — os poucos textos
 *    livres já gravados continuam legíveis; a validação de enum só passa a valer para
 *    gravações novas.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn(
      { tableName: 'opportunities', schema: 'crm' },
      'won_reason',
      {
        type: Sequelize.STRING(32),
        allowNull: true,
        comment: 'Motivo estruturado de GANHO (enum WON) — obrigatório ao entrar em CLOSED_WON.',
      }
    );

    await queryInterface.addColumn(
      { tableName: 'opportunities', schema: 'crm' },
      'withdrawn_reason',
      {
        type: Sequelize.STRING(32),
        allowNull: true,
        comment: 'Motivo estruturado de DESISTÊNCIA (enum WITHDRAWN) — obrigatório ao entrar em WITHDRAWN.',
      }
    );
  },

  down: async (queryInterface) => {
    await queryInterface.removeColumn({ tableName: 'opportunities', schema: 'crm' }, 'withdrawn_reason');
    await queryInterface.removeColumn({ tableName: 'opportunities', schema: 'crm' }, 'won_reason');
  },
};
