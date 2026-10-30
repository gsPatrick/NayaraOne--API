'use strict';

const { getSetting } = require('../../../settings/settings.service');

/** Padrões da contingência do WhatsApp (M9-D227), usados quando a empresa não configurou. Os textos adaptam a mensagem ao e-mail do canal alternativo. */
const PADROES = Object.freeze({
  alternateRequiresOptIn: true,
  alternateEmailSubject: 'Uma mensagem para você',
  alternateEmailIntro: 'Não conseguimos falar com você pelo WhatsApp neste momento; por isso enviamos esta mensagem por e-mail.',
  expiredTemplateName: '',
});

const texto = (v, padrao, max) => (typeof v === 'string' && v.trim().length > 0 && v.length <= max ? v.trim() : padrao);

async function readContingencyMessagingParams(tenant, transaction) {
  const [optIn, assunto, intro, modelo] = await Promise.all([
    getSetting('integration.whatsapp.alternate_requires_opt_in', tenant, transaction, PADROES.alternateRequiresOptIn),
    getSetting('integration.whatsapp.alternate_email_subject', tenant, transaction, PADROES.alternateEmailSubject),
    getSetting('integration.whatsapp.alternate_email_intro', tenant, transaction, PADROES.alternateEmailIntro),
    getSetting('integration.whatsapp.expired_template_name', tenant, transaction, PADROES.expiredTemplateName),
  ]);
  return {
    alternateRequiresOptIn: optIn !== false,
    alternateEmailSubject: texto(assunto, PADROES.alternateEmailSubject, 120),
    alternateEmailIntro: texto(intro, PADROES.alternateEmailIntro, 400),
    expiredTemplateName: typeof modelo === 'string' ? modelo.trim().slice(0, 120) : PADROES.expiredTemplateName,
  };
}

module.exports = { PADROES, readContingencyMessagingParams };
