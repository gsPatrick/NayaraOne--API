'use strict';

// M9-D035 — "Financeiro: sem acesso": na conversa com ferramentas, a recusa de uma área aparece com o rótulo da área, não com o tema técnico.
const { AREAS } = require('./diretoria.policy');

const LABEL_OF = new Map(AREAS.map((a) => [a.topic, a.label]));

/** Troca "Sem permissão para <tema>." (frase da D020) por "<Área>: sem acesso." nos temas que são áreas da Diretoria. */
function areaLabelDecorator(answer) {
  return String(answer).replace(/Sem permissão para (\w+)\./g, (all, topic) => (LABEL_OF.has(topic) ? `${LABEL_OF.get(topic)}: sem acesso.` : all));
}

module.exports = { areaLabelDecorator };
