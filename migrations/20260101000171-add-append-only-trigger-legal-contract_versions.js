'use strict';

/**
 * Migration: trigger de imutabilidade (append-only) em "legal"."contract_versions".
 *
 * O content_hash de uma versão contratual é a prova de qual documento foi assinado. Enquanto a
 * imutabilidade existia só na aplicação (nenhum service faz update), qualquer UPDATE direto no
 * banco — pela própria conexão de runtime da API, por um script, por um SQL colado no console —
 * podia reescrever content_hash/document_file_id e "casar" o registro com outro documento sem
 * deixar rastro de alteração. O trigger move a garantia para o único lugar que vale contra isso:
 * o próprio banco. Qualquer UPDATE nessa tabela passa a levantar exceção.
 *
 * ESCOPO DELIBERADO (documentado): o trigger bloqueia UPDATE, não DELETE. Bloquear DELETE
 * impediria limpeza legítima de dados (LGPD/expurgo de tenant de teste) e, ao contrário do
 * UPDATE silencioso, uma linha removida é detectável (a numeração de versões fica com furo e o
 * histórico de auditoria append-only continua registrando a criação). Superusuário do banco
 * pode desabilitar o trigger — isso é assumido: a defesa aqui é contra adulteração pelo
 * caminho da aplicação/usuário de runtime, não contra quem tem DBA root.
 */
module.exports = {
  up: async (queryInterface) => {
    await queryInterface.sequelize.query(`
      CREATE OR REPLACE FUNCTION legal.contract_versions_block_update()
      RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'legal.contract_versions é append-only: UPDATE não é permitido (versão %, contrato %).',
          OLD.version_number, OLD.contract_id
          USING ERRCODE = '42501';
      END;
      $$ LANGUAGE plpgsql;
    `);
    await queryInterface.sequelize.query(`
      DROP TRIGGER IF EXISTS contract_versions_append_only ON legal.contract_versions;
    `);
    await queryInterface.sequelize.query(`
      CREATE TRIGGER contract_versions_append_only
      BEFORE UPDATE ON legal.contract_versions
      FOR EACH ROW EXECUTE FUNCTION legal.contract_versions_block_update();
    `);
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query(`
      DROP TRIGGER IF EXISTS contract_versions_append_only ON legal.contract_versions;
    `);
    await queryInterface.sequelize.query(`
      DROP FUNCTION IF EXISTS legal.contract_versions_block_update();
    `);
  },
};
