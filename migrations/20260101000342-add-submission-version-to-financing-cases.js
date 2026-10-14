'use strict';

/**
 * Migration: Marco 8 Fase 5 — adiciona `submission_version` a `correspondent.financing_cases`.
 *
 * ACHADO REAL (teste de idempotência CORRESPONDENT-SUB-04, 14/10/2026): a `idempotencyKey` da
 * submissão (`financing:{caseId}:provider:{provider}:v{version}`) inicialmente reusava
 * `lockVersion` (o controle de concorrência otimista do Sequelize) como "version". Só que o
 * PRÓPRIO submitFinancingCase, ao ter sucesso, salva `financingCase.status = 'SUBMITTED'` —
 * e QUALQUER save() incrementa `lockVersion` automaticamente. Resultado: a segunda chamada
 * idêntica (retry/duplo clique) calculava uma key DIFERENTE da primeira (lockVersion já tinha
 * mudado por causa do efeito colateral da própria primeira chamada) e criava uma submissão
 * duplicada — exatamente o bug que a idempotência deveria impedir.
 *
 * Correção: `submission_version` é um contador PRÓPRIO, que só muda quando alguém
 * explicitamente reconhece uma submissão UNKNOWN (`acknowledgeUnknownSubmission`) — nunca como
 * efeito colateral de uma submissão bem-sucedida. Começa em 0.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn(
      { tableName: 'financing_cases', schema: 'correspondent' },
      'submission_version',
      { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 }
    );
  },
  down: async (queryInterface) => {
    await queryInterface.removeColumn({ tableName: 'financing_cases', schema: 'correspondent' }, 'submission_version');
  },
};
