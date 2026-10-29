'use strict';

const fs = require('node:fs');
const path = require('node:path');
const financeEntries = require('./catalog/financeEntries');
const crmOpportunities = require('./catalog/crmOpportunities');
const dimobFile = require('./catalog/dimobFile');
const documents = require('./catalog/documents');

/**
 * Catálogo das exportações (M9-D822, o `exports_catalog` do livro): o que pode ser pedido em POST /exports (colunas com a classe de cada uma, formatos, permissão do
 * módulo, filtro e gerador) e o inventário dos demais geradores de arquivo de `src`. O catálogo é código porque cada entrada carrega o gerador; a classificação por
 * coluna vem daqui enquanto o registro M9-D910 não a assume (DI-D822-1).
 */
const ON_DEMAND = Object.freeze([financeEntries, crmOpportunities, dimobFile].map((entry) => Object.freeze(entry)));
const INVENTORY = Object.freeze([...ON_DEMAND.map((e) => ({ code: e.code, label: e.label, mode: 'ON_DEMAND', sourceFiles: e.sourceFiles })), ...documents]);

const getEntry = (code) => ON_DEMAND.find((entry) => entry.code === code) || null;
const listEntries = () => ON_DEMAND.map((e) => ({ code: e.code, label: e.label, formats: e.formats, permission: e.permission, fixedLayout: Boolean(e.fixedLayout), columns: e.columns.map(({ key, label, classification }) => ({ key, label, classification })) }));

/** Padrão que a varredura procura em `src`: quem escreve CSV, planilha ou PDF (M9-D822 teste 9). */
const GENERATOR_PATTERN = /text\/csv|exceljs|pdfkit/i;
const SRC_ROOT = path.resolve(__dirname, '../../../..');

function walk(dir, out = []) {
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, item.name);
    if (item.isDirectory()) walk(full, out); else if (item.name.endsWith('.js')) out.push(full);
  }
  return out;
}

const covers = (sourceFile, relative) => (sourceFile.endsWith('/') ? relative.startsWith(sourceFile) : relative === sourceFile);

/** Arquivos de `src` que citam CSV, XLSX ou PDF e que nenhuma entrada do inventário cobre; o teste exige lista vazia. */
function scanUncovered(root = SRC_ROOT) {
  const files = INVENTORY.flatMap((e) => e.sourceFiles);
  return walk(root)
    .map((full) => path.relative(root, full).split(path.sep).join('/'))
    .filter((relative) => GENERATOR_PATTERN.test(fs.readFileSync(path.join(root, relative), 'utf8')))
    .filter((relative) => !files.some((sourceFile) => covers(sourceFile, relative)));
}

module.exports = { ON_DEMAND, INVENTORY, getEntry, listEntries, scanUncovered, GENERATOR_PATTERN };
