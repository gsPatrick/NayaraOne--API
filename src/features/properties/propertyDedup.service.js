'use strict';

const { Op } = require('sequelize');
const { Property, PropertyAddress } = require('../../models');

/**
 * propertyDedup.service.js — CRMX-010 ("Deduplicação antes de criar": "Pessoa/imóvel
 * semelhante exige revisão"). Diferente de CRMX-003 (matrícula física idêntica, que BLOQUEIA
 * a criação via `assertRegistryNumberUnique` em properties.service.js), este serviço cobre o
 * caso de endereço parecido SEM matrícula igual — não bloqueia, só avisa (mesmo espírito do
 * "match médio/fraco abre revisão; não mescla automaticamente" já usado em
 * personDedup.service.js para pessoas).
 *
 * Critério de similaridade (documentado, não é fuzzy matching sofisticado): normaliza
 * logradouro + número + cidade (lowercase, sem acento, sem pontuação, espaços colapsados) e
 * compara igualdade exata da chave normalizada. Cobre tanto o endereço "canônico"
 * (PropertyAddress via address_id) quanto as colunas legadas achatadas (addressLine/city),
 * já que o schema mantém as duas formas (ver comentário em src/models/Property.js).
 */

function normalizeAddressKey(street, number, city) {
  const normalize = (value) =>
    String(value || '')
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '') // remove acentos
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim()
      .replace(/\s+/g, ' ');

  const streetNorm = normalize(street);
  const numberNorm = normalize(number);
  const cityNorm = normalize(city);
  if (!streetNorm || !cityNorm) return null;
  return `${streetNorm}|${numberNorm}|${cityNorm}`;
}

/**
 * buildCandidateKey — extrai a chave normalizada de um Property já persistido, preferindo o
 * endereço canônico (PropertyAddress) e caindo para as colunas legadas achatadas.
 */
function buildCandidateKey(property) {
  if (property.address) {
    return normalizeAddressKey(property.address.street, property.address.number, property.address.city);
  }
  return normalizeAddressKey(property.addressLine, null, property.city);
}

/**
 * findSimilarProperties — dado o endereço de um imóvel sendo criado/atualizado (payload bruto,
 * não ainda persistido), varre os imóveis existentes do mesmo grupo e retorna os candidatos com
 * chave de endereço normalizada igual. Não lança erro — quem chama decide o que fazer com o
 * aviso (ex.: devolver em `meta.similarPropertyWarnings` na resposta HTTP, sem bloquear).
 *
 * `addressInput` aceita tanto o formato de PropertyAddress (`{ street, number, city }`) quanto
 * as colunas legadas achatadas (`{ addressLine, city }`) — usa o que estiver disponível.
 */
async function findSimilarProperties({ groupId, street, number, city, addressLine, excludeId }, transaction) {
  const targetKey = street
    ? normalizeAddressKey(street, number, city)
    : normalizeAddressKey(addressLine, null, city);
  if (!targetKey) return [];

  const where = { groupId };
  if (excludeId) where.id = { [Op.ne]: excludeId };

  const candidates = await Property.findAll({
    where,
    include: [{ model: PropertyAddress, as: 'address', required: false }],
    transaction,
  });

  return candidates
    .filter((candidate) => buildCandidateKey(candidate) === targetKey)
    .map((candidate) => ({
      propertyId: candidate.id,
      title: candidate.title,
      internalCode: candidate.internalCode,
      reason: 'ENDERECO_SEMELHANTE',
    }));
}

module.exports = {
  normalizeAddressKey,
  findSimilarProperties,
};
