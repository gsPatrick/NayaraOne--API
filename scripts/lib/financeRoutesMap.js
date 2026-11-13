'use strict';

/**
 * M4-D140 (regra 10 h): mapa das rotas HTTP do Financeiro lido do roteador real — método, caminho, permissões,
 * MFA recente e a cadeia de funções (nomes, na ordem do Express). O retrato de antes da reorganização fica em
 * test/fixtures/m4d140-rotas-http.json e o teste de estrutura compara o mapa atual com ele.
 * Rota do Financeiro = caminho com o segmento /finance (inclui o webhook público do pagamento bancário).
 */
process.env.PORT = process.env.PORT || '0';
const { percorrerRotas } = require('../gerarMatrizPermissoes');

const DO_FINANCEIRO = /\/finance(\/|$)/;

function mapaDeRotasDoFinanceiro() {
  const router = require('../../src/routes');
  const rotas = [];
  percorrerRotas(router.stack, '/api', (method, caminho, handlers) => {
    if (!DO_FINANCEIRO.test(caminho)) return;
    rotas.push({
      method,
      path: caminho,
      permissions: [...new Set(handlers.map((h) => h.requiredPermission).filter(Boolean))],
      mfaRecente: handlers.some((h) => h.name === 'requireRecentMfa'),
      middlewares: handlers.map((h) => h.name || '(anônima)'),
    });
  });
  return rotas.sort((a, b) => (a.path + ' ' + a.method).localeCompare(b.path + ' ' + b.method));
}

module.exports = { mapaDeRotasDoFinanceiro };
