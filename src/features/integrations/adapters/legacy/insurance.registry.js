'use strict';

const { InsuranceSandboxContractAdapter } = require('./insurance.adapters');
const { InsurancePortoContractAdapter, InsuranceYelumContractAdapter, InsuranceJuntoContractAdapter } = require('./insurance.real');
const { InsuranceManualContractAdapter } = require('./insurance.manual');

/** Os adapters de seguro (M9-D238): o sandbox, os três reais que já existiam (Porto Seguro, Yelum e Junto Seguros) e o fluxo manual. Registrados no boot; ver adapters/index.js. */
const INSURANCE_ADAPTERS = Object.freeze([InsuranceSandboxContractAdapter, InsurancePortoContractAdapter, InsuranceYelumContractAdapter, InsuranceJuntoContractAdapter, InsuranceManualContractAdapter]);

module.exports = { INSURANCE_ADAPTERS };
