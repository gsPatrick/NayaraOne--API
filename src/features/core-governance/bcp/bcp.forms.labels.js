'use strict';

/**
 * Rótulos em português dos formulários contingenciais (M9-D834 §3.2): o título de cada tipo e o rótulo impresso de cada campo. Fazem parte da semente do modelo
 * (migration 833); em tempo de execução o rótulo vem da tabela governance.bcp_form_templates.
 */
const TITLES = Object.freeze({
  LEAD_ATENDIMENTO: 'Lead de atendimento',
  REGISTRO_VISITA: 'Registro de visita',
  PROPOSTA_LOCACAO: 'Proposta de locação',
  ENTREGA_CHAVE: 'Entrega de chave',
  RECEBIMENTO: 'Recebimento',
  PAGAMENTO_EMERGENCIAL: 'Pagamento emergencial',
  DIARIO_OBRA: 'Diário de obra',
  REQUISICAO_MATERIAL: 'Requisição de material',
  PROTOCOLO_DOCUMENTO: 'Protocolo de documento',
  ANDAMENTO_PROCESSO: 'Andamento de processo',
  PRAZO_INTIMACAO: 'Prazo ou intimação',
});

const LABELS = Object.freeze({
  nome: 'Nome', telefone: 'Telefone com DDD', email: 'E-mail', interesse: 'Interesse', imovelInteresse: 'Imóvel de interesse', origem: 'Origem do contato', observacao: 'Observação',
  nomeCliente: 'Nome do cliente', imovel: 'Imóvel', dataHoraVisita: 'Data e hora da visita', corretor: 'Corretor',
  proponente: 'Proponente', documento: 'Documento (CPF ou CNPJ)', valorAluguelCentavos: 'Valor do aluguel proposto, em centavos', prazoMeses: 'Prazo em meses', garantia: 'Garantia oferecida',
  contrato: 'Contrato', recebedor: 'Recebedor', documentoRecebedor: 'Documento do recebedor', quantidadeChaves: 'Quantidade de chaves', data: 'Data', estadoImovel: 'Estado do imóvel',
  pagador: 'Pagador', valorCentavos: 'Valor em centavos', forma: 'Forma de pagamento', referenciaParcela: 'Contrato ou parcela', comprovanteAnexado: 'Comprovante anexado',
  favorecido: 'Favorecido', contaOuChavePix: 'Conta ou chave PIX', motivoUrgencia: 'Motivo da urgência', centroCusto: 'Centro de custo', comprovanteObrigacao: 'Comprovante da obrigação',
  conferente1: 'Conferente 1 (nome manuscrito)', conferente1DataHora: 'Conferente 1, data e hora', conferente2: 'Conferente 2 (nome manuscrito)', conferente2DataHora: 'Conferente 2, data e hora',
  obra: 'Obra', clima: 'Clima', equipePresente: 'Equipe presente', servicosExecutados: 'Serviços executados', ocorrencias: 'Ocorrências', fotosQuantidade: 'Fotos (quantidade)',
  material: 'Material', quantidade: 'Quantidade', unidade: 'Unidade', urgencia: 'Urgência', solicitante: 'Solicitante',
  processo: 'Processo', tipoDocumento: 'Tipo de documento', entreguePor: 'Entregue por', recebidoPor: 'Recebido por', classificacao: 'Classificação do documento',
  etapa: 'Etapa', situacao: 'Situação', tipo: 'Tipo (prazo ou intimação)', dataCiencia: 'Data de ciência', dataFinalPrazo: 'Data final do prazo', descricao: 'Descrição', conferidoPor: 'Conferido por',
});

module.exports = { TITLES, LABELS };
