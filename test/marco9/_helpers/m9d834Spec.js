'use strict';

// Tabela 3.2 da M9-D834 escrita à mão (independente do catálogo em código): setor, tipo, ação fixa, campos obrigatórios e opcionais (chaves do payload). Não é teste.
const SPEC = [
  ['ATENDIMENTO', 'LEAD_ATENDIMENTO', 'REGISTER_LEAD', ['nome', 'telefone', 'interesse', 'origem'], ['email', 'imovelInteresse', 'observacao']],
  ['ATENDIMENTO', 'REGISTRO_VISITA', 'REGISTER_VISIT', ['nomeCliente', 'telefone', 'imovel', 'dataHoraVisita', 'corretor'], ['observacao']],
  ['LOCACAO', 'PROPOSTA_LOCACAO', 'REGISTER_PROPOSAL', ['proponente', 'documento', 'imovel', 'valorAluguelCentavos', 'prazoMeses', 'garantia'], ['observacao']],
  ['LOCACAO', 'ENTREGA_CHAVE', 'REGISTER_KEY_DELIVERY', ['contrato', 'imovel', 'recebedor', 'documentoRecebedor', 'quantidadeChaves', 'data'], ['estadoImovel']],
  ['FINANCEIRO', 'RECEBIMENTO', 'RECEIVE_PAYMENT', ['pagador', 'documento', 'valorCentavos', 'forma', 'data', 'referenciaParcela', 'comprovanteAnexado'], []],
  ['FINANCEIRO', 'PAGAMENTO_EMERGENCIAL', 'EMERGENCY_PAYMENT', ['favorecido', 'documento', 'contaOuChavePix', 'valorCentavos', 'motivoUrgencia', 'centroCusto', 'comprovanteObrigacao', 'conferente1', 'conferente1DataHora', 'conferente2', 'conferente2DataHora'], []],
  ['OBRAS', 'DIARIO_OBRA', 'DAILY_REPORT', ['obra', 'data', 'equipePresente', 'servicosExecutados', 'fotosQuantidade'], ['clima', 'ocorrencias']],
  ['OBRAS', 'REQUISICAO_MATERIAL', 'MATERIAL_REQUEST', ['obra', 'material', 'quantidade', 'unidade', 'urgencia', 'solicitante'], []],
  ['CORRESPONDENTE', 'PROTOCOLO_DOCUMENTO', 'REGISTER_DOCUMENT', ['processo', 'tipoDocumento', 'entreguePor', 'recebidoPor', 'data', 'classificacao'], []],
  ['CORRESPONDENTE', 'ANDAMENTO_PROCESSO', 'REGISTER_CASE_PROGRESS', ['processo', 'etapa', 'situacao', 'data'], ['observacao']],
  ['JURIDICO', 'PRAZO_INTIMACAO', 'REGISTER_DEADLINE', ['processo', 'tipo', 'dataCiencia', 'dataFinalPrazo', 'descricao', 'conferidoPor'], []],
].map(([sector, formType, action, required, optional]) => ({ sector, formType, action, required, optional }));

module.exports = { SPEC };
