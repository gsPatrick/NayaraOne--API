'use strict';

/**
 * Obrigações da locação (Guia do Marco 5, §2 leasing/lease-obligation.service): porta do módulo
 * jurídico para legal.lease_obligations (IPTU, condomínio, água, luz, gás, SPU e outras, §12).
 * A regra vive no serviço de utilidades da cobrança (mesma tabela, um só lugar do dado); o
 * módulo jurídico usa estas operações por aqui.
 */
const utilities = require('../../../features/billing/utilities.service');

module.exports = {
  createLeaseObligation: utilities.createUtilityObligation,
  getLeaseObligation: utilities.getUtilityObligation,
  listLeaseObligations: utilities.listUtilityObligations,
  requestOwnershipTransfer: utilities.requestOwnershipTransfer,
  completeOwnershipTransfer: utilities.completeOwnershipTransfer,
  flagOverdueLeaseObligations: utilities.flagOverdueLeaseObligations,
};
