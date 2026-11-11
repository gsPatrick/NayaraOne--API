'use strict';

// M9-D822 — inventário das exportações: toda geração de CSV, XLSX ou PDF achada em `src` consta do catálogo; o catálogo não aponta arquivo que não existe.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const catalog = require('../../../src/features/core-governance/dlp/exports/exports.catalog');

const SRC = path.resolve(__dirname, '../../../src');

test('m9d822 varredura por text/csv, exceljs e pdfkit em src não acha geração de arquivo fora do exports_catalog', () => {
  assert.deepEqual(catalog.scanUncovered(), []);
});

test('m9d822 a varredura realmente acha os geradores conhecidos (não é um passe vazio)', () => {
  const hits = [];
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).forEach((item) => {
    const full = path.join(dir, item.name);
    if (item.isDirectory()) walk(full); else if (item.name.endsWith('.js') && catalog.GENERATOR_PATTERN.test(fs.readFileSync(full, 'utf8'))) hits.push(path.relative(SRC, full).split(path.sep).join('/'));
  });
  walk(SRC);
  for (const expected of ['features/crm/opportunitiesExport.service.js', 'features/correspondent/fiscal/dimob.service.js', 'modules/legal/contracts/application/contractPdf.service.js', 'modules/legal/inspections/inspection.service.js', 'features/correspondent/adapters/NfseAdapter.js', 'features/analytics/exports/export.generate.js']) {
    assert.ok(hits.includes(expected), expected);
  }
  assert.deepEqual(catalog.scanUncovered(), [], 'e todos estão no catálogo');
});

test('m9d822 toda entrada do inventário aponta para arquivos que existem e traz o motivo', () => {
  for (const entry of catalog.INVENTORY) {
    assert.ok(entry.sourceFiles.length, entry.code);
    for (const file of entry.sourceFiles) assert.ok(fs.existsSync(path.join(SRC, file)), `${entry.code}: ${file}`);
  }
  for (const entry of catalog.INVENTORY.filter((e) => e.mode !== 'ON_DEMAND')) assert.ok(entry.reason, entry.code);
});

test('m9d822 as exportações pedidas pelo usuário estão no catálogo com classe em toda coluna e o nó EXPORT de lineage', () => {
  assert.deepEqual(catalog.ON_DEMAND.map((e) => e.code), ['finance.entries', 'crm.opportunities', 'correspondent.dimob']);
  for (const entry of catalog.ON_DEMAND) {
    assert.ok(entry.permission && entry.formats.length, entry.code);
    for (const column of entry.columns) assert.ok(['LOW', 'MEDIUM', 'HIGH', 'RESTRICTED'].includes(column.classification), `${entry.code}.${column.key}`);
    assert.ok(entry.lineage, entry.code);
  }
});
