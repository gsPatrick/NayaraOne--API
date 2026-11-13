'use strict';

const { Property } = require('../../models');
const V = require('../../shared/validation/requestSchema');

/**
 * Tipo e tamanho dos campos de texto e de identificador de `POST /properties` e `PATCH /properties/:id`, conferidos na porta (verificação
 * independente do Marco 9, rodada 7, 12/11/2026; DI-M9R-21). Antes, `title` com 256 caracteres ou `internalCode` com 41 davam 500 (`value too
 * long`). Esquema ABERTO; os limites vêm do modelo (o tamanho da coluna). As regras de negócio continuam no serviço.
 */
const TEXTOS = ['title', 'internalCode', 'propertyType', 'registryNumber', 'registryOffice', 'addressLine', 'city', 'state', 'zipCode', 'description',
  'publicationStatus', 'availabilityStatus', 'publicAddressPolicy', 'addressVisibility', 'descriptionPublic'];
const campos = {
  ...Object.fromEntries(TEXTOS.map((c) => [c, V.textoDoModelo(Property, c)])),
  addressId: V.identificador(),
  latitude: V.numeroOuTexto(),
  longitude: V.numeroOuTexto(),
  areaTotalM2: V.numeroOuTexto(),
};

const CRIAR = V.objetoAberto(campos);
const ATUALIZAR = V.objetoAberto(campos);
/** `POST /properties/:id/offers` (rodada 8, DI-M9R-25): preço é número (ou texto com o número), datas ISO 8601. */
const OFERTA = V.objetoAberto({
  offerType: V.texto(), status: V.texto(), askingPrice: V.numeroOuTexto(), confidentialMinPrice: V.numeroOuTexto(), startsAt: V.dataEmTexto(), endsAt: V.dataEmTexto(),
});
/** `POST /properties/:id/owners` (rodada 8, DI-M9R-25): a pessoa proprietária é um identificador em texto. */
const PROPRIETARIO = V.objetoAberto({ personId: V.identificador(), roleCode: V.texto(), validFrom: V.dataEmTexto(), validUntil: V.dataEmTexto() });

module.exports = {
  validarCriacaoDeImovel: V.validarEntrada({ body: CRIAR }, 'PROPERTY_VALIDATION'),
  validarAtualizacaoDeImovel: V.validarEntrada({ body: ATUALIZAR }, 'PROPERTY_VALIDATION'),
  validarProprietario: V.validarEntrada({ body: PROPRIETARIO }, 'PROPERTY_OWNER_VALIDATION'),
  validarOferta: V.validarEntrada({ body: OFERTA }, 'PROPERTY_OFFER_VALIDATION'),
  ESQUEMAS: { CRIAR, ATUALIZAR, PROPRIETARIO, OFERTA },
};
