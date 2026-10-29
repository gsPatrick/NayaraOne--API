'use strict';

/**
 * Parâmetros da NAY Jurídica (M9-D038), na aba IA NAY de Configurações. Padrão = valor inicial de Maturacao/demandas/parametros.csv.
 * As listas de termos separam por vírgula (sem acento, sem diferenciar maiúsculas); servem a fronteira do agente (scope.guard.js).
 */
const JURIDICA_SETTING_DEFAULTS = Object.freeze({
  'ia.nay_juridica.termos_escopo': 'contrato,clausula,versao,versoes,minuta,aditivo,rascunho,checklist,requisito,prazo,vencimento,juridic,assinatura,assinado,assinada,rescisao,locacao,documento,parecer,validade,valido,valida,processo,legal',
  'ia.nay_juridica.proibicao.decidir_validade': 'esta valido,esta valida,ja esta valido,ja esta valida,validar o contrato,valide o contrato,declare valido,declarar valido,contrato valido,contrato e valido',
  'ia.nay_juridica.proibicao.aprovar_ou_assinar': 'aprovar o contrato,aprove o contrato,aprovar contrato,aprove contrato,assinar o contrato,assine o contrato,assinar contrato,assine contrato,assine por mim,aprovar a minuta,aprove a minuta',
  'ia.nay_juridica.proibicao.enviar_para_assinatura': 'enviar para assinatura,envie para assinatura,enviar o contrato para assinatura,envie o contrato para assinatura,mandar para assinatura,mande para assinatura,disparar a assinatura,dispare a assinatura,enviar ao clicksign,enviar ao zapsign',
  'ia.nay_juridica.proibicao.alterar_versao_assinada': 'alterar a versao assinada,altere a versao assinada,alterar versao assinada,altere versao assinada,editar o contrato assinado,edite o contrato assinado,modificar o contrato assinado,modifique o contrato assinado,alterar o contrato assinado,altere o contrato assinado,mudar a versao assinada,mude a versao assinada',
  'ia.nay_juridica.proibicao.afirmar_prazo_definitivo': 'prazo definitivo,prazo e definitivo,prazo legal definitivo,garanta o prazo,garantir o prazo,confirme o prazo legal,prazo final garantido,prazo e certo',
  'ia.nay_juridica.proibicao.parecer_final': 'parecer juridico,parecer final,emita um parecer,emitir parecer,dar parecer,de um parecer,decisao juridica final,decisao final',
  'ia.nay_juridica.termos_minuta': 'minuta,rascunho,rascunhar,redija o contrato,elabore o contrato,redigir o contrato',
  'ia.nay_juridica.max_itens_lista': 50,
});

const JURIDICA_SETTINGS_SCHEMA = {
  'ia.nay_juridica.termos_escopo': { type: 'string' },
  'ia.nay_juridica.proibicao.decidir_validade': { type: 'string' },
  'ia.nay_juridica.proibicao.aprovar_ou_assinar': { type: 'string' },
  'ia.nay_juridica.proibicao.enviar_para_assinatura': { type: 'string' },
  'ia.nay_juridica.proibicao.alterar_versao_assinada': { type: 'string' },
  'ia.nay_juridica.proibicao.afirmar_prazo_definitivo': { type: 'string' },
  'ia.nay_juridica.proibicao.parecer_final': { type: 'string' },
  'ia.nay_juridica.termos_minuta': { type: 'string' },
  'ia.nay_juridica.max_itens_lista': { type: 'integer', min: 1, max: 200 },
};

module.exports = { JURIDICA_SETTING_DEFAULTS, JURIDICA_SETTINGS_SCHEMA };
