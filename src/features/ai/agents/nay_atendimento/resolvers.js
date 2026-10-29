'use strict';

const AppError = require('../../../../utils/AppError');
const { loadAtendimentoParams } = require('./atendimento.params');
const { publicListings } = require('../../toolServices/atendimento.services');

const SEM_ANUNCIOS = 'No momento não há anúncios públicos disponíveis.';
const PERMISSAO_ANUNCIOS = 'properties:read';
const SEM_PERMISSAO = 'Você não tem permissão para consultar estes dados.';

const linha = (a, i) => `${i + 1}. ${a.title} (${a.purpose}, ${a.type}) - ${a.price}${a.neighborhood ? ` - ${a.neighborhood}` : ''}${a.city ? `, ${a.city}` : ''}`;

/**
 * Resolvedores de regra da NAY Atendimento (caminho RULE do roteador, M9-D012): nenhum chama modelo e o custo é zero. O texto de
 * recusa e o de encaminhamento são os configurados; a lista de anúncios sai do read model público, com a lista como fonte da resposta.
 */
function buildResolvers() {
  return {
    atendimento_recusar: async (input, { tenant, transaction }) => ({ answer: (await loadAtendimentoParams(tenant, transaction)).mensagemForaDoEscopo }),
    atendimento_encaminhar: async (input, { tenant, transaction }) => ({ answer: (await loadAtendimentoParams(tenant, transaction)).mensagemEncaminhamento }),
    atendimento_listar_anuncios: async (input, { tenant, transaction }) => {
      if (!(input.permissions || []).includes(PERMISSAO_ANUNCIOS)) throw new AppError(SEM_PERMISSAO, 403, 'AI_PERMISSION_DENIED');
      const { items } = await publicListings(transaction, { ...tenant }).list();
      if (!items.length) return { answer: SEM_ANUNCIOS };
      const texto = items.map(linha).join('\n');
      return {
        answer: texto,
        sources: [{ sourceType: 'READ_MODEL', sourceRef: 'public_property_read_model', title: 'Anúncios públicos', text: texto, classification: 'PUBLIC' }],
      };
    },
  };
}

module.exports = { buildResolvers };
