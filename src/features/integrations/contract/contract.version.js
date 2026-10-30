'use strict';

const AppError = require('../../../utils/AppError');
const { hashAdapter } = require('./contract.run');
const adapterRegistry = require('../registry/adapterRegistry');

/** Hash do adapter que está no código agora (o mesmo que a suíte grava no relatório): relatório de contrato ou de ensaio com outro hash é de outra versão. null = sem adapter registrado. */
function currentAdapterHash(providerCode) {
  const instancia = adapterRegistry.instantiate(providerCode);
  return instancia ? hashAdapter(instancia.constructor, providerCode, instancia.supportedVersions()) : null;
}

/** O relatório cobre a versão de API da connection (a lista `apiVersions` do relatório); connection sem versão informada usa a padrão do adapter e não restringe. Lança 409. */
function assertReportCoversApiVersion(report, apiVersion) {
  if (!apiVersion) return;
  if (!Array.isArray(report.apiVersions) || !report.apiVersions.includes(apiVersion)) {
    throw AppError.conflict('O relatório de contract tests não cobre a versão da API desta integração: rode a suíte de novo.', 'INTEGRATION_CONTRACT_REPORT_API_VERSION');
  }
}

module.exports = { currentAdapterHash, assertReportCoversApiVersion };
