'use strict';

/**
 * M9-D046 — volume da carga da NAY. É fixture de teste (o livro pede "carga" sem meta de desempenho): o que importa são as invariantes sob
 * concorrência, não a vazão. Valores padrão do script; o chamador pode trocar qualquer um.
 */
const VOLUME_PADRAO = Object.freeze({
  usuariosPorEmpresa: 3, // pessoas diferentes por empresa, todas em paralelo
  execucoesPorUsuario: 4, // runs simultâneos de cada pessoa
  custoPorExecucao: 10, // R$ por run (fixture [[CUSTO:n]] do provider sandbox)
  limiteDoOrcamento: 60, // R$ por empresa: cabem 6 runs de 10; o resto precisa ser recusado
  aceitesSimultaneos: 5, // a mesma aprovação enviada por tantas conexões ao mesmo tempo
  repeticoesDaToolCall: 5, // a mesma tool call enviada por tantas conexões ao mesmo tempo
});

module.exports = { VOLUME_PADRAO };
