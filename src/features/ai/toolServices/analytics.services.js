'use strict';

// M9-D695 — o serviço de leitura do BI que as ferramentas da NAY Diretoria chamam. O agente não recebe conexão de banco: só este mapa de
// funções de leitura (catálogo fechado de 7), ligadas à transação do tenant e às permissões do usuário que pediu.
const { createNayAnalytics } = require('../../analytics/briefs');

function analyticsBi(transaction, scope = {}) {
  return createNayAnalytics(transaction, scope);
}

module.exports = { analyticsBi };
