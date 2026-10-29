'use strict';

/**
 * Parâmetros da NAY Documental (M9-D040), na aba IA NAY de Configurações. Padrão = valor inicial de Maturacao/demandas/parametros.csv.
 * As listas de termos são texto separado por vírgula (sem acento, sem diferenciar maiúsculas) e servem à fronteira do agente
 * (agents/scope) e à troca da resposta que afirma ter gravado ou aprovado. `tipos_documento` e `campos_obrigatorios` são o vocabulário
 * da classificação e da checagem: `TIPO=termo,termo;OUTRO=termo` e `TIPO=campo,campo;OUTRO=campo`. O livro não fixa nenhum destes
 * valores; o padrão é conservador. A confiança mínima é a mesma que o cadastro de documentos de pessoa já usa (0,7).
 */
const DOCUMENTAL_KEYS = Object.freeze({
  scopeTerms: 'ia.documental.termos_escopo',
  forbidSaveToRecord: 'ia.documental.proibicao.gravar_no_cadastro',
  forbidApprove: 'ia.documental.proibicao.aprovar_documento',
  forbidUnverified: 'ia.documental.proibicao.arquivo_nao_verificado',
  forbidKeepFullText: 'ia.documental.proibicao.reter_texto_integral',
  answerTerms: 'ia.documental.termos_resposta_proibida',
  documentTypes: 'ia.documental.tipos_documento',
  requiredFields: 'ia.documental.campos_obrigatorios',
  minConfidence: 'ia.documental.confianca_minima',
  maxTranscriptChars: 'ia.documental.max_caracteres_transcricao',
});
const K = DOCUMENTAL_KEYS;

const DOCUMENTAL_SETTING_DEFAULTS = Object.freeze({
  [K.scopeTerms]: 'documento,arquivo,ocr,transcricao,transcrever,transcreva,classificar,classifique,classificacao,extrair,extraia,extracao,campo,campos,nota,valor total,checar,cheque,confira,checagem,consistencia,divergencia,leia,sugira,nota fiscal,rg,cpf,cnpj,cnh,comprovante,contrato,matricula,holerite,extrato,certidao,iptu,escaneado,digitalizado,imagem,pdf,foto',
  [K.forbidSaveToRecord]: 'grave no cadastro,gravar no cadastro,salve no cadastro,salvar no cadastro,grave os campos,gravar os campos,salve os campos,salvar os campos,preencha o cadastro,preencher o cadastro,atualize o cadastro,atualizar o cadastro,cadastre os dados,cadastrar os dados,registre no cadastro,registrar no cadastro,sobrescreva o cadastro,sobrescrever o cadastro,grave a classificacao,gravar a classificacao,salve a classificacao,salvar a classificacao',
  [K.forbidApprove]: 'aprove o documento,aprovar o documento,aprovar documento,valide o documento,validar o documento,marque como verificado,marcar como verificado,marque o documento como,marcar o documento como,confirme o documento,confirmar o documento,aceite o documento,aceitar o documento,de o ok no documento,libere o documento,liberar o documento',
  [K.forbidUnverified]: 'sem antivirus,ignore o antivirus,ignorar o antivirus,ignorando o antivirus,desconsidere o antivirus,sem passar pelo antivirus,sem checar o antivirus,pule o antivirus,pular o antivirus,sem verificar o antivirus,arquivo nao verificado,arquivo sem verificacao,nao verificado pelo antivirus,de outra empresa,da outra empresa,arquivo da empresa b,outro cliente',
  [K.forbidKeepFullText]: 'guarde o texto completo,guardar o texto completo,salve o texto completo,salvar o texto completo,armazene o texto completo,armazenar o texto completo,guarde a transcricao,guardar a transcricao,salve a transcricao,salvar a transcricao,armazene a transcricao,armazenar a transcricao,copie o documento inteiro,copiar o documento inteiro',
  [K.answerTerms]: 'documento aprovado,documento foi aprovado,aprovei o documento,gravei no cadastro,gravei os campos,salvei no cadastro,salvei os campos,cadastro atualizado,cadastro foi atualizado,campos gravados,dados gravados no cadastro,classificacao gravada,documento validado por mim,marquei como verificado,guardei o texto',
  [K.documentTypes]: 'RG=registro geral,carteira de identidade,rg;CPF=cadastro de pessoas fisicas,cpf;CNH=carteira nacional de habilitacao,cnh;COMPROVANTE_RESIDENCIA=comprovante de residencia,conta de luz,conta de agua,fatura de energia;COMPROVANTE_RENDA=comprovante de renda,holerite,contracheque,declaracao de imposto de renda;MATRICULA_IMOVEL=matricula do imovel,registro de imoveis,cartorio de registro;IPTU=iptu,imposto predial;EXTRATO_BANCARIO=extrato bancario,saldo anterior,agencia e conta;CERTIDAO_ESTADO_CIVIL=certidao de casamento,certidao de nascimento,estado civil;INVOICE_NF=nota fiscal,nf-e,danfe,valor total da nota',
  [K.requiredFields]: 'RG=name;CPF=name,taxId;CNH=name,issuedAt,expiresAt;COMPROVANTE_RENDA=name,income;EXTRATO_BANCARIO=name,accountNumber;INVOICE_NF=valor_total;CNPJ=taxId',
  [K.minConfidence]: 0.7,
  [K.maxTranscriptChars]: 4000,
});

const TERMS = { type: 'string' };
const DOCUMENTAL_SETTINGS_SCHEMA = {
  [K.scopeTerms]: TERMS,
  [K.forbidSaveToRecord]: TERMS,
  [K.forbidApprove]: TERMS,
  [K.forbidUnverified]: TERMS,
  [K.forbidKeepFullText]: TERMS,
  [K.answerTerms]: TERMS,
  [K.documentTypes]: TERMS,
  [K.requiredFields]: TERMS,
  [K.minConfidence]: { type: 'number', min: 0, max: 1 },
  [K.maxTranscriptChars]: { type: 'integer', min: 200, max: 50000 },
};

module.exports = { DOCUMENTAL_KEYS, DOCUMENTAL_SETTING_DEFAULTS, DOCUMENTAL_SETTINGS_SCHEMA };
