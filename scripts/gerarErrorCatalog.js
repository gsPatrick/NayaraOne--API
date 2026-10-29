#!/usr/bin/env node
'use strict';
/**
 * Atualiza o catálogo de códigos de erro (M9-D843 §3.4) a partir de src/features/core-governance: errorCatalog.data.json e docs/ERROR_CODES.md.
 *   node scripts/gerarErrorCatalog.js          -> grava os dois arquivos (códigos novos entram com a versão atual do contrato; os sem status/mensagem extraíveis ficam incompletos para preencher à mão)
 */
const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');
const { buildCatalog } = require('../src/features/core-governance/api-governance/standards/errorCatalog.build');
const { readData, writeData, entriesFromData } = require('../src/features/core-governance/api-governance/standards/errorCatalog.data');
const { renderMarkdown } = require('../src/features/core-governance/api-governance/standards/errorCatalog.markdown');

const ROOT = path.resolve(__dirname, '..');
const contract = yaml.load(fs.readFileSync(path.join(ROOT, 'openapi/openapi.v1.yaml'), 'utf8'));
const data = buildCatalog({ dir: path.join(ROOT, 'src/features/core-governance'), data: readData(), since: contract.info.version });
writeData(data);
fs.writeFileSync(path.join(ROOT, 'docs/ERROR_CODES.md'), renderMarkdown(entriesFromData(data)));
const incomplete = Object.entries(data.codes).filter(([, e]) => !e.status || !e.message).map(([code]) => code);
console.log(`Catálogo: ${Object.keys(data.codes).length} códigos${incomplete.length ? `; INCOMPLETOS (preencher em errorCatalog.data.json): ${incomplete.join(', ')}` : ''}.`);
