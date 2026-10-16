'use strict';

/**
 * Migration: achado A10 (auditoria externa Nayara, 15/10/2026) — decideApprovalStep só
 * comparava `expectedLockVersion` contra o lock_version atual da entidade QUANDO o cliente
 * decidia enviar esse campo (opcional). Omitir o campo dispensava toda a checagem — uma
 * aprovação podia ser concedida mesmo que o registro (ex: valor, conta bancária do favorecido)
 * tivesse mudado depois da solicitação original, sem nenhuma validação.
 *
 * Adiciona `lock_version_at_request` (capturado no SERVIDOR, no momento de
 * createApprovalRequest — nunca confiado do cliente) em `finance.approval_requests`. A partir
 * de agora, decideApprovalStep valida esse snapshot SEMPRE que presente, nunca como campo
 * opcional do payload do decisor.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn(
      { tableName: 'approval_requests', schema: 'finance' },
      'lock_version_at_request',
      { type: Sequelize.INTEGER, allowNull: true }
    );

    await queryInterface.sequelize.query(
      'GRANT SELECT, INSERT, UPDATE ON "finance"."approval_requests" TO nayara_runtime;'
    );
  },

  down: async (queryInterface) => {
    await queryInterface.removeColumn({ tableName: 'approval_requests', schema: 'finance' }, 'lock_version_at_request');
  },
};
