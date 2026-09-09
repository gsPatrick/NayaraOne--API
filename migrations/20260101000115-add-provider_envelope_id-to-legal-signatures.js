'use strict';

/**
 * Migration: adiciona "legal"."signatures"."provider_envelope_id".
 *
 * DECISÃO DE ENGENHARIA — não especificado no Caderno: até aqui, `requestSignature` recebia o
 * ID do envelope/documento criado no provedor (Clicksign/ZapSign) mas descartava esse valor
 * depois de resolver os IDs individuais de signatário — não havia como, depois, consultar
 * status ou cancelar a assinatura no provedor real (só o webhook alimentava o status). Como o
 * envelope é compartilhado por todos os signatários de uma mesma versão de contrato, gravamos
 * o mesmo `provider_envelope_id` em cada linha de `Signature` daquele envelope — permite que
 * `checkSignatureStatus`/`cancelSignature` (signatures.service.js) operem por signatário sem
 * precisar de uma tabela de envelope separada.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn(
      { tableName: 'signatures', schema: 'legal' },
      'provider_envelope_id',
      { type: Sequelize.STRING(128), allowNull: true }
    );
  },

  down: async (queryInterface) => {
    await queryInterface.removeColumn({ tableName: 'signatures', schema: 'legal' }, 'provider_envelope_id');
  },
};
