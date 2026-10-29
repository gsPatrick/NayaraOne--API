'use strict';

/**
 * M9-D037 — conteúdo do agente NAY_OBRAS no padrão do sistema (versão 1, DRAFT, desabilitada): propósito, política, escopos de dados,
 * limites (max_tool_calls_por_run = 6), criticidade, allowlist de tools (ai.agent_tools, só leitura) e o golden dataset do sistema
 * (ai.golden_cases). Hash de configuração igual ao da aplicação. Nenhuma tabela nova (RLS FORCE da 701/722 mantido); GRANTs não mudam.
 */
const { migrationDoAgente } = require('./_helpers/aiAgentContentMigration');

module.exports = migrationDoAgente(require('./_helpers/aiAgentObras'));
