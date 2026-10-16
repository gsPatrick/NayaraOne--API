'use strict';

// GAP REAL CORRIGIDO (auditoria real Nayara, Marco 7, 2026-10-14, achado F11): EST-006 exige que
// a saída de ferramenta registre responsável, destino, data prevista de retorno E condição — a
// condição só era registrada na DEVOLUÇÃO (condition_code), nunca na SAÍDA. Adiciona a coluna
// separada condition_out_code pra não confundir "estado em que saiu" com "estado em que voltou".
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn(
      { schema: 'inventory', tableName: 'tool_loans' },
      'condition_out_code',
      { type: Sequelize.STRING(16), allowNull: true }
    );
    // GRANT explícito — lição aprendida no Marco 8 (Fase 2): não confiar em default privileges
    // de migrations anteriores pra colunas novas em tabela já existente (colunas não precisam de
    // GRANT de tabela de novo, mas deixamos o comentário pra reforçar a prática em quem revisar).
  },
  async down(queryInterface) {
    await queryInterface.removeColumn({ schema: 'inventory', tableName: 'tool_loans' }, 'condition_out_code');
  },
};
