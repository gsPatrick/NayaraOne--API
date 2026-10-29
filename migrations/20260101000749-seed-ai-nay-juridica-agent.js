'use strict';

/**
 * M9-D038 — conteúdo do agente NAY_JURIDICA no padrão do sistema (versão 1, DRAFT, desabilitada, CRITICAL): propósito, política, escopos
 * de dados, limites (max_tool_calls_por_run = 6), allowlist de tools (leitura e a única escrita, legal.draftContract, HIGH com aprovação
 * humana) e o golden dataset do sistema. Hash de configuração igual ao da aplicação. Nenhuma tabela nova; GRANTs não mudam.
 */
const { migrationDoAgente } = require('./_helpers/aiAgentContentMigration');

module.exports = migrationDoAgente(require('./_helpers/aiAgentJuridica'));
