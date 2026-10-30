'use strict';

/**
 * Janela da taxa de runs por pessoa (um minuto). O limitador em memória que morava aqui saiu (DI-IA-LEVE-5): ele não era usado no fluxo de
 * produção e, por viver na memória de UMA instância, não valeria com mais de uma. A taxa vale pelo contador de banco (runs recentes da
 * pessoa em ai.ai_runs, `AgentRunGuard.assertRateCount`, DI-D004-7), que é o que o orquestrador chama ao abrir o run.
 */
const WINDOW_MS = 60000;

module.exports = { WINDOW_MS };
