'use strict';

/**
 * M9-D612 — as ÚNICAS rotas de usuário que escrevem em /analytics (M9-D600, seção 3.5): reconhecer alerta (colunas de
 * reconhecimento de alert_instances, M9-D703) e pedir exportação (export_jobs, M9-D701). Nenhuma escreve fora do schema analytics.
 * Publicar métrica e criar alerta (escritas administrativas) entram aqui quando a demanda dona (M9-D702, M9-D691) registrar a rota:
 * o teste de varredura reprova qualquer escrita de /analytics que não esteja nesta lista.
 */
const ANALYTICS_WRITE_ROUTES = Object.freeze([
  Object.freeze({ method: 'POST', path: '/analytics/alerts/:id/ack' }),
  Object.freeze({ method: 'POST', path: '/analytics/exports' }),
  // M9-D687: publicação administrativa de painel (analytics:manage); grava só em analytics.dashboard_*.
  Object.freeze({ method: 'POST', path: '/analytics/dashboards' }),
  // M9-D686: limiar de saúde mudou = nova versão do painel (analytics:manage); grava só em analytics.dashboard_*.
  Object.freeze({ method: 'POST', path: '/analytics/dashboards/health/thresholds' }),
]);

module.exports = { ANALYTICS_WRITE_ROUTES };
