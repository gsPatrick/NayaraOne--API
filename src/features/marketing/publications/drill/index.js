'use strict';

/**
 * M9-D442 — failure drill de provedor por canal. Fachada: `runDrill` (os 12 cenários em cada canal pedido, relatório), `assertPassed` (MKT_DRILL_FAILED na divergência),
 * `toText`/`writeReport` (saída do script `npm run marketing:drill`) e `recordChannelResult` (evidência FAILURE_DRILL do releaseChannel).
 */
const { runDrill, runCase } = require('./drill.run');
const { assertPassed, toText, writeReport } = require('./drill.report');
const { recordChannelResult } = require('./drill.record');
const { runCli } = require('./drill.cli');
const { DRILL_SCENARIOS, EXIT } = require('./drill.constants');
const { DRILL_SETTINGS_SCHEMA, DRILL_SETTING_DEFAULTS, KEYS, readDrillParams } = require('./drill.settings');

module.exports = { runCli, runDrill, runCase, assertPassed, toText, writeReport, recordChannelResult, DRILL_SCENARIOS, EXIT, DRILL_SETTINGS_SCHEMA, DRILL_SETTING_DEFAULTS, KEYS, readDrillParams };
