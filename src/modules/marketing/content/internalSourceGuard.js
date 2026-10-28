'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { mktError } = require('../marketing.errors');

/**
 * M9-D403 — Teste estático do CI: o serviço de conteúdo do Marketing não pode ler tabela de origem (imóvel, ocorrência,
 * documento, pessoa, contrato...). Só as visões `marketing.*` são fontes. A varredura recusa, em cada .js da pasta:
 *  - referência a tabela com esquema que não seja `marketing` (ex.: real_estate.properties, people.persons);
 *  - require dos models que importe algo além de `sequelize` (nenhum model de origem, como Property ou Person).
 * Falha com 500 MKT_INTERNAL_SOURCE_FORBIDDEN (bloqueio de CI), listando arquivo e linha.
 */
const SOURCE_SCHEMAS = ['real_estate', 'legal', 'construction', 'people', 'finance', 'crm', 'correspondent', 'inventory', 'procurement', 'core', 'audit'];
const SCHEMA_REF = new RegExp(`\\b(?:${SOURCE_SCHEMAS.join('|')})\\s*\\.\\s*"?[a-z_]+`, 'i');
const MODELS_REQUIRE = /require\(\s*['"][./]+\/models(?:\/index)?['"]\s*\)/;
const ONLY_SEQUELIZE = /const\s*\{\s*sequelize\s*\}\s*=\s*require\(/;
const SELF = path.basename(__filename);

function listJs(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listJs(full));
    else if (entry.name.endsWith('.js') && entry.name !== SELF) out.push(full);
  }
  return out;
}

function findInternalSourceViolations(dir) {
  const violations = [];
  for (const file of listJs(dir)) {
    fs.readFileSync(file, 'utf8').split('\n').forEach((line, index) => {
      const code = line.replace(/\/\/.*$/, '').trim();
      if (!code || code.startsWith('*') || code.startsWith('/*')) return;
      if (SCHEMA_REF.test(code) && /['"`]/.test(code)) violations.push({ file, line: index + 1, text: line.trim() });
      else if (MODELS_REQUIRE.test(code) && !ONLY_SEQUELIZE.test(code)) violations.push({ file, line: index + 1, text: line.trim() });
    });
  }
  return violations;
}

function assertContentServiceSources(dir) {
  const violations = findInternalSourceViolations(dir);
  if (violations.length > 0) {
    throw mktError(500, 'MKT_INTERNAL_SOURCE_FORBIDDEN', 'Conteúdo só pode ser gerado a partir de read models públicos.', { violations });
  }
  return true;
}

module.exports = { findInternalSourceViolations, assertContentServiceSources };
