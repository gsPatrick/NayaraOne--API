'use strict';

// Textos fixos do livro (Caderno §10, AI-008, AI-009). Mudar uma frase aqui muda o produto: não são parâmetro.
const MENSAGEM_INSUFICIENCIA = 'Não tenho informações suficientes nas fontes autorizadas para responder isso com segurança.';
const MENSAGEM_PRAZO_SEM_FONTE_EXATA = 'Não tenho a fonte exata deste prazo; consulte o responsável jurídico.';
const MENSAGEM_CONFIRMACAO_HUMANA = 'Confirmação humana necessária antes de agir.';
const MENSAGEM_DIVERGENCIA = 'Atenção: as fontes consultadas divergem.';

const FUSO = 'America/Sao_Paulo';
const TIPO_RECOMENDACAO_CONFIRMACAO = 'REQUIRES_CONFIRMATION';
const PERMISSAO_JURIDICO = 'legal:read';

/** Tipos de fonte calculados por read model ou tool: sem pontuação de relevância, valem como exatos. */
const TIPOS_DETERMINISTICOS = Object.freeze(['READ_MODEL', 'TOOL_RESULT']);
const STATUS_FONTE_INVALIDA = Object.freeze(['REVOGADA', 'EXPIRADA']);

module.exports = {
  MENSAGEM_INSUFICIENCIA, MENSAGEM_PRAZO_SEM_FONTE_EXATA, MENSAGEM_CONFIRMACAO_HUMANA, MENSAGEM_DIVERGENCIA, FUSO,
  TIPO_RECOMENDACAO_CONFIRMACAO, PERMISSAO_JURIDICO, TIPOS_DETERMINISTICOS, STATUS_FONTE_INVALIDA,
};
