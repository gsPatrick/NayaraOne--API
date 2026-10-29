'use strict';

/**
 * Marco 9, demanda M9-D652 (KPI recorrência por causa, equipe e material): read model analytics.rm_project_occurrences, uma linha por ocorrência de
 * obra (não conformidade ou caso de garantia/manutenção pós-obra) com a data (calendário de São Paulo), a causa, as equipes e os materiais envolvidos
 * e o custo. A janela de recorrência é parâmetro do administrador e se aplica na leitura, por isso a tabela guarda a ocorrência, não a contagem.
 * Causa, equipe e material sem informação entram como 'NAO_INFORMADA'. Só ids e rótulos (nada de descrição nem de pessoa). RLS ENABLE + FORCE por
 * company_id. Faixa reservada: 9800 a 9807.
 */
const { MONEY, createReadModelTable, grantRuntime, dropTables } = require('./_helpers/analyticsReadModelTables');

const TABLE = {
  name: 'rm_project_occurrences',
  key: ['project_id', 'occurrence_type', 'occurrence_id'],
  columns: [
    'project_id uuid NOT NULL', 'occurrence_type varchar(24) NOT NULL', 'occurrence_id uuid NOT NULL', 'occurred_on date NOT NULL', 'cause varchar(64) NOT NULL',
    "teams jsonb NOT NULL DEFAULT '[]'::jsonb", "materials jsonb NOT NULL DEFAULT '[]'::jsonb", MONEY('cost'),
  ],
};

module.exports = {
  up: async (queryInterface) => {
    const q = (sql) => queryInterface.sequelize.query(sql);
    await q('CREATE SCHEMA IF NOT EXISTS "analytics"');
    await createReadModelTable(q, TABLE);
    await grantRuntime(q, [TABLE.name]);
  },

  down: async (queryInterface) => {
    await dropTables((sql) => queryInterface.sequelize.query(sql), [TABLE.name]);
  },
};
