'use strict';

/**
 * Livro do Marco 3 §12: "Não inferir atributo sensível do cliente". As categorias são as do dado pessoal sensível da LGPD (art. 5º, II):
 * origem racial ou étnica, convicção religiosa, opinião política, filiação a sindicato ou a organização de caráter religioso, filosófico ou
 * político, saúde, vida sexual, dado genético e dado biométrico. O livro não dá a lista de palavras: cada categoria é um parâmetro da
 * empresa (aba IA NAY), termos separados por vírgula, sem acento e sem diferenciar maiúsculas; o termo casa no começo de uma palavra
 * ("catolic" pega "católico" e "católica"). DI-M3CB-21.
 */
const SENSITIVE_KEYS = Object.freeze({
  racial: 'ia.comercial.sensivel.origem_racial_etnica',
  religion: 'ia.comercial.sensivel.conviccao_religiosa',
  politics: 'ia.comercial.sensivel.opiniao_politica',
  union: 'ia.comercial.sensivel.filiacao_organizacao',
  health: 'ia.comercial.sensivel.saude',
  sexual: 'ia.comercial.sensivel.vida_sexual',
  genetic: 'ia.comercial.sensivel.dado_genetico',
  biometric: 'ia.comercial.sensivel.dado_biometrico',
  forbidInfer: 'ia.comercial.proibicao.inferir_atributo_sensivel',
});

/** Rótulo de cada categoria (vai na explicação estruturada da remoção; o termo removido nunca é repetido na resposta). */
const SENSITIVE_LABELS = Object.freeze({
  racial: 'origem racial ou étnica',
  religion: 'convicção religiosa',
  politics: 'opinião política',
  union: 'filiação a sindicato ou organização religiosa, filosófica ou política',
  health: 'saúde',
  sexual: 'vida sexual',
  genetic: 'dado genético',
  biometric: 'dado biométrico',
});

const S = SENSITIVE_KEYS;
const SENSITIVE_SETTING_DEFAULTS = Object.freeze({
  [S.racial]: 'raca,racial,etnia,etnic,afrodescendente,cor da pele,indigena,quilombola',
  [S.religion]: 'religiao,religios,catolic,evangelic,protestante,espirita,umbanda,candomble,judeu,judia,judaic,muculman,islamic,budista,ateu,ateia,igreja,templo,culto religioso,pastor,padre',
  [S.politics]: 'opiniao politica,ideologia politica,partido politico,petista,bolsonarista,esquerdista,direitista,comunista,eleitor,vota em,votou em,votar em',
  [S.union]: 'sindicato,sindicaliz,sindical,filiado ao partido,filiada ao partido,maconaria,macom,associacao religiosa,organizacao filosofica',
  [S.health]: 'doenca,doente,diagnostic,cancer,hiv,aids,diabet,depressao,depressiv,ansiedade,gravida,gestante,gravidez,deficiencia,deficiente,cadeirante,autis,transtorno,tratamento medico,medicament,cirurgia,quimioterapia,internad,plano de saude dele,plano de saude dela',
  [S.sexual]: 'orientacao sexual,vida sexual,homossexual,heterossexual,bissexual,gay,lesbica,transexual,transgenero,lgbt',
  [S.genetic]: 'genetic,dna,genoma,exame de paternidade',
  [S.biometric]: 'biometri,impressao digital,reconhecimento facial,leitura de iris',
  [S.forbidInfer]: 'religiao do cliente,religiao dele,religiao dela,qual a religiao,orientacao sexual,etnia do cliente,raca do cliente,cor da pele,partido do cliente,em quem ele vota,em quem ela vota,em quem o cliente vota,o cliente e gay,ele e gay,ela e gay,o cliente e sindicalizado,doenca do cliente,saude do cliente,o cliente esta doente,a cliente esta gravida,ela esta gravida,o cliente tem alguma doenca,descubra a religiao,descubra a orientacao,infira a religiao,infira a orientacao',
});

const SENSITIVE_SETTINGS_SCHEMA = Object.freeze(Object.fromEntries(Object.values(SENSITIVE_KEYS).map((k) => [k, { type: 'string' }])));

/** Categorias com termos (sem a chave da proibição de entrada, que é frase de pedido e não termo de saída). */
const CATEGORY_KEYS = Object.freeze(Object.entries(SENSITIVE_KEYS).filter(([cat]) => cat !== 'forbidInfer'));

module.exports = { SENSITIVE_KEYS, SENSITIVE_LABELS, SENSITIVE_SETTING_DEFAULTS, SENSITIVE_SETTINGS_SCHEMA, CATEGORY_KEYS };
