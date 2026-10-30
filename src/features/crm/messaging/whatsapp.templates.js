'use strict';

const E = require('./whatsapp.errors');

const contarVariaveis = (variables) => (Array.isArray(variables) ? variables.length : (Number.isInteger(variables) && variables >= 0 ? variables : 0));
const contarRecebidas = (vars) => (Array.isArray(vars) ? vars.length : (vars && typeof vars === 'object' ? Object.keys(vars).length : 0));

/**
 * Modelo de mensagem (M9-D230 3.1): precisa constar em `config_json.templates[]` da connection ({name, language, category, variables, approvedAt, approved}) como aprovado, e o número
 * de variáveis enviado precisa ser o do modelo. Sem o modelo na lista ou com `approved` diferente de true: 422 TEMPLATE_NOT_APPROVED; variáveis a mais ou a menos: 422 VARIABLES_MISMATCH.
 */
function assertTemplate(connection, input) {
  const modelos = Array.isArray((connection.configJson || {}).templates) ? connection.configJson.templates : [];
  const idioma = input.language ? String(input.language) : null;
  const achado = modelos.find((m) => m && m.name === input.templateName && (!idioma || !m.language || m.language === idioma));
  if (!achado || achado.approved !== true) throw E.templateNotApproved(input.templateName);
  const esperadas = contarVariaveis(achado.variables);
  const recebidas = contarRecebidas(input.templateVars);
  if (esperadas !== recebidas) throw E.variablesMismatch(esperadas, recebidas);
  return achado;
}

module.exports = { assertTemplate };
