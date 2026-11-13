'use strict';

/**
 * M9-D612 (3.1 item 2) — o código do BI (src/features/analytics) não importa serviços de escrita de outros
 * módulos. Regra de lint com resolução real do caminho (um `no-restricted-modules` por texto não pega "../../marketing/x").
 * Proibido: qualquer arquivo de src/features/<outro> ou de src/modules/<módulo> (Guia M4 §2 e M5 §2). Permitido: o próprio analytics, a leitura de
 * parâmetros (features/settings/settings.service) e repositórios de leitura (*.readRepository.js). Models, utils, engines e
 * middlewares ficam fora de features e seguem permitidos.
 */
const path = require('node:path');

const SRC = path.resolve(__dirname, '..', '..', 'src');
const OWN = ['features/analytics'];
const ALLOWED_FILES = [/^features\/settings\/settings\.service(\.js)?$/, /\.readRepository(\.js)?$/];

function forbidden(relative) {
  if (!/^(features|modules)\//.test(relative)) return false; // M4-D140: o Financeiro (e o Jurídico) vivem em src/modules
  if (OWN.some((own) => relative === own || relative.startsWith(`${own}/`))) return false;
  return !ALLOWED_FILES.some((re) => re.test(relative));
}

module.exports = {
  meta: {
    type: 'problem',
    schema: [],
    messages: { proibido: 'O BI é somente leitura (BI-001): não importe serviço de outro módulo ("{{spec}}"). Leia por repositório de leitura ou read model.' },
  },
  create(context) {
    const dir = path.dirname(context.filename);
    function check(node, spec) {
      if (typeof spec !== 'string' || !spec.startsWith('.')) return;
      const relative = path.relative(SRC, path.resolve(dir, spec)).split(path.sep).join('/');
      if (forbidden(relative)) context.report({ node, messageId: 'proibido', data: { spec } });
    }
    return {
      CallExpression(node) {
        if (node.callee.type === 'Identifier' && node.callee.name === 'require' && node.arguments[0]?.type === 'Literal') check(node, node.arguments[0].value);
      },
      ImportDeclaration(node) { check(node, node.source.value); },
    };
  },
};
