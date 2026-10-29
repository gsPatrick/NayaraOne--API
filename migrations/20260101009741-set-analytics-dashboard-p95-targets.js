'use strict';

/**
 * Marco 9, demanda M9-D698 (3.5): meta p95 de cada painel do catálogo (analytics.dashboard_definitions.p95_target_ms, a ÚNICA fonte da meta).
 * O seed da 9687 gravou a mesma meta provisória em todos; aqui entram as do livro por tipo de painel:
 *   Financeiro, Vendas/CRM, Locação, Marketing, Atendimento/Satisfação = 1.500 ms
 *   Obras, Estoque/Patrimônio, Pós-obra, Jurídico, Correspondente    = 1.800 ms
 *   Segurança/Integrações/IA                                          = 1.400 ms
 *   Centro de Comando (Saúde Geral inclusa)                           = 2.500 ms
 * A definição publicada é imutável por gatilho; este ajuste de dado do catálogo global desliga o gatilho só dentro da transação (como o down da
 * 9687) e só toca a coluna da meta das definições GLOBAIS PUBLISHED. Idempotente. Faixa de migrations do BI: 9741 a 9748.
 */
const TARGETS = {
  finance: 1500, crm: 1500, rental: 1500, marketing: 1500, support: 1500,
  construction: 1800, inventory: 1800, postwork: 1800, legal: 1800, correspondent: 1800,
  tech: 1400, command_center: 2500, health: 2500,
};
const PREVIOUS = 3000;

async function setTargets(queryInterface, targetOf) {
  const sequelize = queryInterface.sequelize;
  await sequelize.transaction(async (transaction) => {
    const q = (sql, replacements) => sequelize.query(sql, { transaction, replacements });
    await q("SELECT set_config('app.analytics_writer', 'on', true)");
    await q('ALTER TABLE analytics.dashboard_definitions DISABLE TRIGGER dashboard_definitions_guard');
    try {
      for (const code of Object.keys(TARGETS)) {
        await q(
          `UPDATE analytics.dashboard_definitions SET p95_target_ms = :target
            WHERE dashboard_code = :code AND company_id IS NULL AND group_id IS NULL AND status = 'PUBLISHED'`,
          { code, target: targetOf(code) }
        );
      }
    } finally {
      await q('ALTER TABLE analytics.dashboard_definitions ENABLE TRIGGER dashboard_definitions_guard');
    }
  });
}

module.exports = {
  TARGETS,
  up: (queryInterface) => setTargets(queryInterface, (code) => TARGETS[code]),
  down: (queryInterface) => setTargets(queryInterface, () => PREVIOUS),
};
