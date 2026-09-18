'use strict';

/**
 * Migration: UNIQUE (contract_id, version_number) em "legal"."contract_versions".
 *
 * ContractVersion é append-only por design (o service nunca faz update), mas o BANCO não
 * garantia nada: duas transações concorrentes podiam ler o mesmo "última versão = 1" e gravar
 * duas linhas "versão 2" para o mesmo contrato — e nada impedia inserir uma segunda "versão 1"
 * depois, o que na prática permitiria "reverter" a versão vigente plantando uma linha nova com
 * número antigo. A UNIQUE transforma isso em erro de banco (a segunda gravação falha), que é o
 * único ponto onde a garantia é real sob concorrência.
 */
module.exports = {
  up: async (queryInterface) => {
    await queryInterface.addConstraint(
      { tableName: 'contract_versions', schema: 'legal' },
      {
        fields: ['contract_id', 'version_number'],
        type: 'unique',
        name: 'contract_versions_contract_version_unique',
      }
    );
  },

  down: async (queryInterface) => {
    await queryInterface.removeConstraint(
      { tableName: 'contract_versions', schema: 'legal' },
      'contract_versions_contract_version_unique'
    );
  },
};
