'use strict';

/** Contract tests dos adapters (Marco 9, M9-D222). Fachada da API do módulo. */
const { runSuite, hashAdapter, SCENARIOS } = require('./contract.run');
const { listTargets, coverage, FIRST, PENDING_BY_DEMAND } = require('./contract.targets');
const { writeReport, readReport, assertContractReportForRelease, reportDir } = require('./contract.report');
const { loadFixture, listFixtureProviders } = require('./contract.fixtures');
const { CONTRACT_SETTINGS_SCHEMA } = require('./contract.settings');
const { readContractParams } = require('./contract.params');
const { currentAdapterHash, assertReportCoversApiVersion } = require('./contract.version');

module.exports = {
  runSuite, hashAdapter, SCENARIOS, listTargets, coverage, FIRST, PENDING_BY_DEMAND, writeReport, readReport, assertContractReportForRelease, reportDir, loadFixture, listFixtureProviders, CONTRACT_SETTINGS_SCHEMA, readContractParams, currentAdapterHash, assertReportCoversApiVersion,
};
