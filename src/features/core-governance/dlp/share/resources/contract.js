'use strict';

const { Contract, ContractParty } = require('../../../../../models');
const { govNotFound } = require('../../../governance.errors');

/** Contrato (legal.contracts) com as partes: o que a leitura autenticada devolve, reduzido ao que um destinatário externo precisa. Classe por campo = padrão do catálogo (M9-D910 a assume). */
module.exports = {
  code: 'legal.contract',
  label: 'Contrato',
  permission: 'legal:read',
  fields: {
    id: 'LOW', contractNumber: 'MEDIUM', contractType: 'LOW', status: 'LOW', totalValue: 'HIGH', startsAt: 'LOW', endsAt: 'LOW',
    'parties.role': 'LOW', 'parties.name': 'HIGH', 'parties.taxId': 'RESTRICTED',
  },
  async assertShareable(_ctx, id, transaction) {
    if (!(await Contract.findByPk(id, { attributes: ['id'], transaction }))) throw govNotFound('Registro não encontrado.');
  },
  async load(_ctx, id, transaction) {
    const contract = await Contract.findByPk(id, { transaction });
    if (!contract) return null;
    const parties = await ContractParty.findAll({ where: { contractId: id }, include: [{ association: 'person', attributes: ['legalName', 'taxIdNormalized'] }], transaction });
    return {
      data: {
        id: contract.id, contractNumber: contract.contractNumber, contractType: contract.contractType, status: contract.status,
        totalValue: contract.totalValue === null || contract.totalValue === undefined ? null : String(contract.totalValue), startsAt: contract.startsAt, endsAt: contract.endsAt,
        parties: parties.map((party) => ({ role: party.partyRole, name: party.person ? party.person.legalName : null, taxId: party.person ? party.person.taxIdNormalized : null })),
      },
    };
  },
};
