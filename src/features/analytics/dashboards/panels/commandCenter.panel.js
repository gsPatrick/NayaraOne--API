'use strict';

/**
 * M9-D685 — conteúdo do painel Centro de Comando (`command_center`): a faixa de qualidade (sempre o primeiro), o briefing da NAY Diretoria e os SEIS blocos do livro (§4)
 * na ordem das seis perguntas. Cada bloco declara em `config.dependsOn` as métricas de que depende (M9-D697: com alguma DEGRADED, INCOMPLETE ou STALE ele adia a
 * conclusão). `blockKey` liga o widget ao construtor do bloco em `dashboards/command`; `config` só descreve, nenhuma fórmula. Dado puro: o mesmo texto alimenta a migration.
 */
const { QUALITY_BANNER } = require('./common');
const { BLOCKS, DEPENDS_ON } = require('../command/command.map');

const BRIEF = Object.freeze({ widgetType: 'BRIEF', title: 'Briefing executivo', valueNature: 'ACTUAL', drilldownEnabled: false, config: {} });
const block = (spec) => ({
  widgetType: 'COMMAND_BLOCK', title: spec.title, valueNature: 'ACTUAL', drilldownEnabled: false,
  config: { blockKey: spec.key, question: spec.question, dependsOn: [...DEPENDS_ON[spec.key]] },
});

const COMMAND_CENTER_PANEL = Object.freeze({ code: 'command_center', widgets: [QUALITY_BANNER, BRIEF, ...BLOCKS.map(block)] });

module.exports = { COMMAND_CENTER_PANEL };
