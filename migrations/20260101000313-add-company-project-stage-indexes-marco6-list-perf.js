'use strict';

/**
 * GATE-DB-09 / DB-TS-015 (contrato §16: "Volume simulado de anos de operação -> Metas p95
 * atendidas ou plano de otimização"; "Metas iniciais: p95 < 300ms em consultas comuns") —
 * auditoria de carga REAL do módulo de Obras (Marco 6), resposta ao achado da auditora de que
 * "testes de falha e de duas aprovações concorrentes não comprovam carga" (correto — carga !=
 * concorrência). Ver `scripts/loadTestConstruction.js` e `scripts/README-load-test.md` para o
 * script, o volume seedado e os números medidos na íntegra. Mesmo padrão das migrations
 * 20260101000299/300/301 ("marco7-list-perf"): tenant isolado (`bbbbbbbb-...`), seed real,
 * EXPLAIN ANALYZE real + chamada real ao service, limpo ao final.
 *
 * Volume seedado: 300.000 `construction.projects`, 308.000 `construction.stage_measurements`
 * (8.000 numa única etapa "alvo"), 151.800 `construction.daily_reports` (1.800 numa única obra
 * "alvo") — nenhuma das 3 tabelas tinha índice além da PK.
 *
 * EXPLAIN ANALYZE real (SQL equivalente ao que cada service gera, já com RLS ativo):
 *   - listProjects (WHERE company_id ORDER BY created_at DESC, 300k linhas na empresa):
 *     Seq Scan + Sort com "Sort Method: external merge Disk: 42944kB" — 331ms de execução SQL
 *     pura (acima da própria meta de 300ms já no SQL cru, sem contar ORM/rede).
 *   - listStageMeasurements (WHERE project_stage_id ORDER BY measured_at DESC, 1 etapa em
 *     meio a 308k linhas): Parallel Seq Scan — 28ms de execução SQL pura.
 *   - listDailyReports (WHERE project_id ORDER BY report_date DESC, 1 obra em meio a 151.8k
 *     linhas): Seq Scan — 14ms de execução SQL pura.
 *
 * Medição ponta a ponta via SERVICE (mesma transação/RLS do runtime, 20 execuções cada):
 *   - projectsService.listProjects:            p50=12976,88ms p95=13827,85ms p99=14552,73ms
 *   - stageMeasurementsService.listStageMeasurements: p50=1251,14ms p95=1311,55ms p99=1839,73ms
 *   - dailyReportsService.listDailyReports:    p50=806,46ms  p95=853,28ms  p99=875,59ms
 *
 * TODAS as 3 estouram a meta de p95 < 300ms. `listProjects` estoura MESMO no SQL cru (Seq
 * Scan + Sort em disco com 300k linhas sem índice) — índice composto resolve pra Index Scan,
 * eliminando o sort em disco.
 *
 * ACHADO ADICIONAL (documentado em detalhe no README do load test, não "escondido" atrás do
 * índice): para `listStageMeasurements`/`listDailyReports`, o SQL cru já roda em <30ms — a
 * lacuna até os 800-1300ms medidos ponta a ponta é dominada por latência de rede dos 3
 * round-trips seriais de `SET LOCAL app.group_id/app.company_id/app.user_id` + BEGIN/COMMIT
 * que `tenant.middleware.js` faz por chamada (não pela ausência de índice). O índice aqui
 * criado é aplicado mesmo assim (mesmo padrão de precaução das rodadas anteriores — qualquer
 * tabela que acumula histórico "anos de operação" ganha índice de apoio à consulta de
 * listagem), mas FECHAR a meta de 300ms nessas duas consultas específicas exige endereçar o
 * overhead de round-trips do tenant middleware, que fica registrado como gap em aberto no
 * README (fora do escopo de uma migration de índice).
 */
module.exports = {
  up: async (queryInterface) => {
    await queryInterface.sequelize.query(
      'CREATE INDEX IF NOT EXISTS projects_company_created_idx ON construction.projects (company_id, created_at DESC)'
    );
    await queryInterface.sequelize.query(
      'CREATE INDEX IF NOT EXISTS stage_measurements_stage_measured_idx ON construction.stage_measurements (project_stage_id, measured_at DESC)'
    );
    await queryInterface.sequelize.query(
      'CREATE INDEX IF NOT EXISTS daily_reports_project_report_date_idx ON construction.daily_reports (project_id, report_date DESC)'
    );
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query('DROP INDEX IF EXISTS construction.projects_company_created_idx');
    await queryInterface.sequelize.query('DROP INDEX IF EXISTS construction.stage_measurements_stage_measured_idx');
    await queryInterface.sequelize.query('DROP INDEX IF EXISTS construction.daily_reports_project_report_date_idx');
  },
};
