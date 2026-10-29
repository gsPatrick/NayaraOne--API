'use strict';

const fs = require('node:fs');
const path = require('node:path');

/** O catálogo versionado (errorCatalog.data.json): { codes: { CODIGO: { status, message, module, since, deprecated } } }. Fonte única de docs/ERROR_CODES.md e de governance.error_catalog. */
const FILE = path.join(__dirname, 'errorCatalog.data.json');

function readData() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (_e) { return { codes: {} }; }
}

const entriesFromData = (data = readData()) => Object.entries(data.codes).sort(([a], [b]) => a.localeCompare(b)).map(([code, e]) => ({
  code, status: e.status, message: e.message, module: e.module, since: e.since, deprecated: Boolean(e.deprecated),
}));

function writeData(data) {
  const sorted = { codes: Object.fromEntries(Object.entries(data.codes).sort(([a], [b]) => a.localeCompare(b))) };
  fs.writeFileSync(FILE, `${JSON.stringify(sorted, null, 2)}\n`);
}

module.exports = { FILE, readData, writeData, entriesFromData };
