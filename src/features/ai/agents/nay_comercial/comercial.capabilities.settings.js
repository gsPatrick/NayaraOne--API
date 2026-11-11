'use strict';

/**
 * Parâmetros das capacidades da NAY Comercial que o livro do Marco 3 §16 e §12 pede e não quantifica (aba IA NAY de Configurações).
 * Cada um é decisão registrada (DI-M3CB-20 a 29) e editável pelo administrador; o padrão é o valor inicial.
 *  - lead esquecido (§16 "Detecta lead esquecido"): liga/desliga da detecção automática, prazo em dias sem contato, de quantas em quantas
 *    horas a rotina passa na empresa e o tamanho da lista sob demanda;
 *  - qualidade do cadastro (§16 "Classifica qualidade do cadastro e documentos faltantes"): documentos exigidos por tipo de pessoa (grupos
 *    separados por vírgula; alternativas do mesmo grupo separadas por "|") e as notas que separam BOM, REGULAR e RUIM;
 *  - mensagem recebida (§12 "resumo NAY, sentimento/ocorrência apenas como apoio"): tamanho do resumo e as palavras que indicam cada tipo de
 *    ocorrência do §15 (reclamação, elogio, conflito, atendimento inadequado, retorno pendente);
 *  - envio de mensagem (§16 "Não envia mensagem de alto impacto sem regras/consentimento"): a finalidade conferida no consentimento e o canal
 *    padrão quando o pedido não diz o canal;
 *  - redação: `ia.comercial.redacao_por_modelo` liga a redação por modelo da descrição de imóvel e do resumo de mensagem (com a guarda);
 *    desligado, o texto é montado pelo código só com os fatos;
 *  - descrição (Guia §12 "Não invente metragem, acabamento, localização ou benefício"): as características, acabamentos, localizações e
 *    benefícios que a guarda só aceita quando estão nos fatos públicos aprovados do imóvel.
 */
const CAP_KEYS = Object.freeze({
  forgottenEnabled: 'ia.comercial.lead_esquecido.ativo',
  forgottenDays: 'ia.comercial.lead_esquecido.dias_sem_contato',
  forgottenIntervalHours: 'ia.comercial.lead_esquecido.intervalo_horas',
  forgottenListMax: 'ia.comercial.lead_esquecido.max_lista',
  docsPf: 'ia.comercial.cadastro.documentos_pf',
  docsPj: 'ia.comercial.cadastro.documentos_pj',
  qualityGood: 'ia.comercial.cadastro.nota_bom',
  qualityFair: 'ia.comercial.cadastro.nota_regular',
  messageSummaryChars: 'ia.comercial.mensagem.resumo_max_caracteres',
  termsComplaint: 'ia.comercial.mensagem.termos_reclamacao',
  termsCompliment: 'ia.comercial.mensagem.termos_elogio',
  termsConflict: 'ia.comercial.mensagem.termos_conflito',
  termsPoorService: 'ia.comercial.mensagem.termos_atendimento_inadequado',
  termsPendingReturn: 'ia.comercial.mensagem.termos_retorno_pendente',
  sendPurpose: 'ia.comercial.envio.finalidade_consentimento',
  sendChannel: 'ia.comercial.envio.canal_padrao',
  draftByModel: 'ia.comercial.redacao_por_modelo',
  descriptionTerms: 'ia.comercial.descricao.termos_controlados',
});

const K = CAP_KEYS;
const CAP_SETTING_DEFAULTS = Object.freeze({
  [K.forgottenEnabled]: true,
  [K.forgottenDays]: 7,
  [K.forgottenIntervalHours]: 24,
  [K.forgottenListMax]: 20,
  [K.docsPf]: 'RG|CIN|CNH|RG_CPF',
  [K.docsPj]: 'CNPJ',
  [K.qualityGood]: 80,
  [K.qualityFair]: 50,
  [K.messageSummaryChars]: 280,
  [K.termsComplaint]: 'reclamacao,reclamar,reclamo,insatisfeit,absurdo,pessimo,horrivel,descaso,decepcionad,nao gostei,problema',
  [K.termsCompliment]: 'parabens,obrigad,excelente,otimo atendimento,muito bom,adorei,gostei muito,satisfeit,recomendo,maravilhos',
  [K.termsConflict]: 'vou processar,processar,procon,advogado,justica,cancelar tudo,devolucao do sinal,quero meu dinheiro,briga,discussao',
  [K.termsPoorService]: 'grosseir,mal atendid,ninguem responde,sem resposta,me ignor,falta de respeito,demora no atendimento,atendimento ruim',
  [K.termsPendingReturn]: 'aguardo retorno,aguardando retorno,ainda nao retornaram,me retorne,retorne,fico no aguardo,pode me ligar,me liga',
  [K.sendPurpose]: 'MARKETING',
  [K.sendChannel]: 'WHATSAPP',
  [K.draftByModel]: false,
  [K.descriptionTerms]: 'suite,piscina,churrasqueira,varanda,sacada,elevador,academia,playground,salao de festas,portaria,ar-condicionado,ar condicionado,mobiliad,aceita pets,pet friendly,vaga coberta,closet,lareira,jardim,quintal,area gourmet,espaco gourmet,sauna,quadra,hidromassagem,jacuzzi,porcelanato,marmore,granito,laminado,madeira de lei,alto padrao,acabamento,reformad,recem-reformad,vista para o mar,vista mar,frente mar,beira mar,vista panoramica,proximo a,proximo ao,proximo de,proxima a,perto de,ao lado de,a poucos,estacao de metro,shopping,escola,condominio fechado,seguranca 24h,financiamento,aceita permuta,permuta,documentacao em dia,escriturad,valorizacao,oportunidade unica,ensolarad,sol da manha,silencios,arejad,iluminad',
});

const STRING = { type: 'string' };
const CAP_SETTINGS_SCHEMA = Object.freeze({
  [K.forgottenEnabled]: { type: 'boolean' },
  [K.forgottenDays]: { type: 'integer', min: 1, max: 365 },
  [K.forgottenIntervalHours]: { type: 'integer', min: 1, max: 168 },
  [K.forgottenListMax]: { type: 'integer', min: 1, max: 100 },
  [K.docsPf]: STRING,
  [K.docsPj]: STRING,
  [K.qualityGood]: { type: 'integer', min: 1, max: 100 },
  [K.qualityFair]: { type: 'integer', min: 0, max: 100 },
  [K.messageSummaryChars]: { type: 'integer', min: 40, max: 2000 },
  [K.termsComplaint]: STRING,
  [K.termsCompliment]: STRING,
  [K.termsConflict]: STRING,
  [K.termsPoorService]: STRING,
  [K.termsPendingReturn]: STRING,
  [K.sendPurpose]: { type: 'string', enum: ['MARKETING', 'CADENCE', 'CAMPAIGN', 'COMMERCIAL', 'TRANSACTIONAL'] },
  [K.sendChannel]: { type: 'string', enum: ['WHATSAPP', 'EMAIL', 'SMS', 'PHONE'] },
  [K.draftByModel]: { type: 'boolean' },
  [K.descriptionTerms]: STRING,
});

module.exports = { CAP_KEYS, CAP_SETTING_DEFAULTS, CAP_SETTINGS_SCHEMA };
