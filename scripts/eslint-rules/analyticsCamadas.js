'use strict';

/**
 * M9-D613 (3.2) — regras de dependência entre as camadas de src/features/analytics:
 *  - metrics/formulas/*: puras; só importam arquivos de metrics/ (e módulos nativos do Node). Sem models, sequelize, pg, utils.
 *  - dashboards/ e briefs/: sem models/sequelize/pg e sem serviço de outro módulo (nunca tabelas de origem); a camada
 *    read-models é consumida só pelo index.js (API pública).
 * A leitura dos schemas de origem fica em read-models/ (única camada), sem regra aqui.
 */
const path = require('node:path');
const { builtinModules } = require('node:module');

const SRC = path.resolve(__dirname, '..', '..', 'src');
const BASE = path.join(SRC, 'features', 'analytics');
const DB_PACKAGES = new Set(['sequelize', 'pg', 'pg-hstore', 'knex']);

function camadaDe(filename) {
  const rel = path.relative(BASE, filename).split(path.sep).join('/');
  if (rel.startsWith('..')) return null;
  if (rel.startsWith('metrics/formulas/')) return 'formula';
  if (rel.startsWith('dashboards/') || rel.startsWith('briefs/')) return 'consumidor';
  return null;
}

function motivo(camada, spec, dir) {
  const bare = !spec.startsWith('.');
  if (bare) {
    const nome = spec.replace(/^node:/, '').split('/')[0];
    if (DB_PACKAGES.has(spec.split('/')[0])) return 'acesso ao banco';
    if (camada === 'formula' && !spec.startsWith('node:') && !builtinModules.includes(nome)) return 'a fórmula é pura e só usa módulos nativos';
    return null;
  }
  const alvo = path.resolve(dir, spec);
  const rel = path.relative(SRC, alvo).split(path.sep).join('/');
  if (camada === 'formula') {
    return alvo === path.join(BASE, 'metrics') || alvo.startsWith(path.join(BASE, 'metrics') + path.sep) ? null : 'a fórmula só importa de metrics/';
  }
  if (rel === 'models' || rel.startsWith('models/')) return 'tabelas de origem pelos models';
  if (/^features\//.test(rel) && !rel.startsWith('features/analytics')) return 'serviço de outro módulo';
  const m = /^features\/analytics\/read-models\/(.+)$/.exec(rel);
  if (m && m[1] !== 'index' && m[1] !== 'index.js') return 'use a API pública de read-models (index.js)';
  return null;
}

module.exports = {
  meta: {
    type: 'problem',
    schema: [],
    messages: { proibido: 'Camadas do BI (M9-D613): "{{spec}}" não é permitido aqui ({{motivo}}).' },
  },
  create(context) {
    const camada = camadaDe(context.filename);
    if (!camada) return {};
    const dir = path.dirname(context.filename);
    function check(node, spec) {
      if (typeof spec !== 'string') return;
      const m = motivo(camada, spec, dir);
      if (m) context.report({ node, messageId: 'proibido', data: { spec, motivo: m } });
    }
    return {
      CallExpression(node) {
        if (node.callee.type === 'Identifier' && node.callee.name === 'require' && node.arguments[0]?.type === 'Literal') check(node, node.arguments[0].value);
      },
      ImportDeclaration(node) { check(node, node.source.value); },
    };
  },
};
