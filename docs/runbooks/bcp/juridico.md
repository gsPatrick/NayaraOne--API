# Runbook de continuidade — Jurídico

Roteiro impresso para operar **sem o sistema** no setor de Jurídico e lançar tudo depois sem perder nada. Formulários do setor: PRAZO_INTIMACAO (intenção `REGISTER_DEADLINE`). Prefixo da numeração: `JUR` (número `JUR-AAAA-nnnnn`, impresso no papel).

## 1. Quando acionar
O sistema está indisponível e o responsável do setor decide acionar a contingência. Anote a hora de início no primeiro formulário. Não acione por lentidão: só por indisponibilidade que impeça o trabalho.

## 2. Quem aciona e quem é o responsável
- Aciona e responde: Advogado responsável (substituto: o advogado indicado pela coordenação jurídica).
- O responsável avisa a equipe, distribui os blocos numerados e controla a faixa de números usada.

## 3. O que continua funcionando sem o sistema
Acompanhar prazos pelos meios oficiais (diário, portal do tribunal, intimações em papel) e atender clientes por telefone.

## 4. Passo a passo manual
1. Para cada prazo ou intimação, preencha o formulário **PRAZO_INTIMACAO** (número `JUR-AAAA-nnnnn`): processo, tipo (prazo ou intimação), data de ciência, data final, descrição e quem conferiu.
2. Conte o prazo duas vezes, por duas pessoas, e escreva as duas datas na folha.
3. Comunique o prazo mais curto ao responsável no mesmo dia.
4. Fotografe a folha com a intimação anexada (evidência do registro).

## 5. O que é proibido fazer manualmente
- Deixar prazo sem a conferência de segunda pessoa.
- Protocolar peça ou aceitar acordo sem o advogado responsável.
- Apagar ou rasurar prazo já registrado (risque e anote).

## 6. Como registrar para reconciliação
- Cada formulário tem seu número `JUR-AAAA-nnnnn`; esse número é a ponte com o sistema e nunca se repete.
- Fotografe ou escaneie cada folha preenchida: a imagem é a evidência obrigatória do registro (`POST /bcp/manual-operations`).
- Folhas do mesmo caso compartilham a mesma referência de correlação (`correlationRef`), informada ao registrar.
- Use o campo de valores em centavos, inteiros, sem vírgula nem ponto.

## 7. Como encerrar a contingência e importar
1. Com o sistema de volta, o responsável confere se todas as folhas usadas têm foto e número.
2. Quem tem permissão do setor registra cada folha em `POST /bcp/manual-operations`; folha com dado errado fica registrada com o erro e é corrigida em `PATCH /bcp/manual-operations/:id`.
3. A importação para o sistema e a conciliação seguem o procedimento de importação do BCP (M9-D832). Só depois dela o responsável registra o fim da contingência (hora de término) e arquiva as folhas originais.
