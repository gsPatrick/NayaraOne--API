'use strict';

/**
 * Migration: adiciona `content` (TEXT, nullable) em "legal"."contract_versions".
 *
 * DECISÃO DE ENGENHARIA (22/09/2026): até aqui `createContractVersion` recebia `content` só
 * pra calcular `content_hash` e DESCARTAVA o texto — nada de recuperável ficava gravado, por
 * isso o SignatureAdapter tinha que subir um `.txt` de referência (sem o texto real do
 * contrato) pro provedor de assinatura. Persistir o texto aqui permite reconstruir o PDF do
 * contrato SOB DEMANDA (pdfkit, em memória, ver contractPdf.service.js) sempre que necessário
 * — sem precisar de storage de binário/disco pra contratos: mesmo texto -> mesmo PDF -> mesmo
 * hash, de forma determinística. É só texto (poucos KB por versão), não pesa o banco como um
 * PDF binário pesaria.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn(
      { tableName: 'contract_versions', schema: 'legal' },
      'content',
      {
        type: Sequelize.TEXT,
        allowNull: true,
      }
    );
  },

  down: async (queryInterface) => {
    await queryInterface.removeColumn({ tableName: 'contract_versions', schema: 'legal' }, 'content');
  },
};
