'use strict';

// Agentes do livro com conteúdo próprio (M9-D034 a M9-D041): cada pacote registra a sua fronteira, os resolvedores RULE e os números.
// Carregado pelo índice de agentes, de modo que qualquer caminho que use o orquestrador já os tem registrados.
const { wireScopeGuard } = require('./scope');
const { registerNayObras } = require('./nay_obras');
const { registerNayJuridica } = require('./nay_juridica');
const { registerNayCorrespondente } = require('./nay_correspondente');
const { registerNayDocumental } = require('./nay_documental');
const { registerNayDiretoria } = require('./nay_diretoria');
const { registerNayFinanceira } = require('./nay_financeira');
const { registerNayComercial } = require('./nay_comercial');

let done = false;
function registerBuiltInAgents() {
  if (done) return;
  done = true;
  wireScopeGuard();
  registerNayObras();
  registerNayJuridica();
  registerNayCorrespondente();
  registerNayDocumental();
  registerNayDiretoria();
  registerNayFinanceira();
  registerNayComercial();
}

registerBuiltInAgents();

module.exports = { registerBuiltInAgents };
