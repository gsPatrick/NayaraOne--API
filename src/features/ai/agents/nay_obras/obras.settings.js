'use strict';

/**
 * Parâmetros da NAY Obras (M9-D037), na aba IA NAY de Configurações. Padrão = valor inicial de Maturacao/demandas/parametros.csv.
 * As listas de termos separam por vírgula (sem acento, sem diferenciar maiúsculas); servem a fronteira do agente (scope.guard.js).
 */
const OBRAS_SETTING_DEFAULTS = Object.freeze({
  'ia.nay_obras.termos_escopo': 'obra,obras,projeto,cronograma,prazo,atraso,atrasad,custo,orcamento,orcado,realizado,diario,rdo,medicao,qualidade,conformidade,garantia,pos-obra,pos obra,chamado,etapa,empreiteiro,canteiro,engenharia,material,desperdicio,avanco,progresso',
  'ia.nay_obras.proibicao.alterar_medicao': 'alterar a medicao,alterar medicao,altere a medicao,altere medicao,mudar a medicao,mude a medicao,ajustar a medicao,ajuste a medicao,corrigir a medicao,corrija a medicao,aprovar a medicao,aprove a medicao,aprovar medicao,rejeitar a medicao,rejeite a medicao',
  'ia.nay_obras.proibicao.aprovar_pagamento_empreiteiro': 'aprovar pagamento,aprove o pagamento,aprove pagamento,aprovar o pagamento,liberar pagamento,libere o pagamento,libere pagamento,liberar o pagamento,pagar o empreiteiro,pague o empreiteiro,pagar empreiteiro',
  'ia.nay_obras.proibicao.alterar_cronograma_orcamento': 'alterar o cronograma,alterar cronograma,altere o cronograma,altere cronograma,mudar o cronograma,mude o cronograma,adiar a obra,adie a obra,adiar o prazo,adie o prazo,alterar o orcamento,alterar orcamento,altere o orcamento,altere orcamento,mudar o orcamento,mude o orcamento,reduzir o orcamento,aumentar o orcamento,aumente o orcamento',
  'ia.nay_obras.proibicao.encerrar_garantia': 'encerrar a garantia,encerrar garantia,encerre a garantia,encerre garantia,fechar a garantia,feche a garantia,fechar garantia,dar baixa na garantia,de baixa na garantia',
  'ia.nay_obras.max_itens_lista': 20,
  'ia.nay_obras.diario_janela_dias': 15,
});

const OBRAS_SETTINGS_SCHEMA = {
  'ia.nay_obras.termos_escopo': { type: 'string' },
  'ia.nay_obras.proibicao.alterar_medicao': { type: 'string' },
  'ia.nay_obras.proibicao.aprovar_pagamento_empreiteiro': { type: 'string' },
  'ia.nay_obras.proibicao.alterar_cronograma_orcamento': { type: 'string' },
  'ia.nay_obras.proibicao.encerrar_garantia': { type: 'string' },
  'ia.nay_obras.max_itens_lista': { type: 'integer', min: 1, max: 100 },
  'ia.nay_obras.diario_janela_dias': { type: 'integer', min: 1, max: 90 },
};

module.exports = { OBRAS_SETTING_DEFAULTS, OBRAS_SETTINGS_SCHEMA };
