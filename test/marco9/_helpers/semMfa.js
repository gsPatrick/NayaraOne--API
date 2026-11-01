'use strict';

const { MfaCredential, MfaStepUp } = require('../../../src/models');

/**
 * Deixa o usuário SEM MFA dentro da transação do teste (o rollback devolve o estado): testes que provam "MFA exigido" não podem depender de o banco compartilhado
 * ainda estar sem credencial, porque outros arquivos habilitam MFA para o usuário do seed e o estado fica gravado (hermeticidade, M9-D200/D202 R4-L1).
 */
async function semMfa(userId, transaction) {
  await MfaStepUp.destroy({ where: { userId }, transaction });
  await MfaCredential.destroy({ where: { userId }, transaction });
}

module.exports = { semMfa };
