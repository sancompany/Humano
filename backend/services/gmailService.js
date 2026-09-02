/**
 * SAN & CO. — backend/services/gmailService.js
 * Leitura de mensagens recentes e envio de e-mail simples. A API do
 * Gmail devolve o corpo da mensagem em MIME (as vezes em várias partes,
 * texto+HTML), então `listarMensagensRecentes` fica só nos metadados —
 * assunto, remetente, data, resumo — que já cobre "o que chegou", sem
 * precisar decodificar um e-mail inteiro. Ler o corpo completo de uma
 * mensagem específica é uma função separada, pra adicionar quando (e se)
 * fizer falta de verdade.
 */

import { google } from 'googleapis';
import { getClienteGoogle } from './googleAuth.js';

function cabecalho(mensagem, nome) {
  return mensagem.payload?.headers?.find((h) => h.name === nome)?.value ?? null;
}

/**
 * Lista as mensagens mais recentes da caixa de entrada — só metadados.
 * @param {number} limite
 */
export async function listarMensagensRecentes(limite = 10) {
  const gmail = google.gmail({ version: 'v1', auth: getClienteGoogle() });

  const lista = await gmail.users.messages.list({
    userId: 'me',
    maxResults: limite,
    labelIds: ['INBOX']
  });

  const ids = lista.data.messages ?? [];

  // a API não devolve assunto/remetente na listagem — precisa buscar cada
  // mensagem individualmente, só que em formato "metadata" (rápido, sem
  // baixar o corpo inteiro)
  const mensagens = await Promise.all(
    ids.map(async ({ id }) => {
      const { data } = await gmail.users.messages.get({
        userId: 'me',
        id,
        format: 'metadata',
        metadataHeaders: ['Subject', 'From', 'Date']
      });
      return {
        id: data.id,
        assunto: cabecalho(data, 'Subject'),
        de: cabecalho(data, 'From'),
        data: cabecalho(data, 'Date'),
        resumo: data.snippet
      };
    })
  );

  return mensagens;
}

/**
 * Envia um e-mail de texto simples. A API do Gmail exige o e-mail
 * inteiro em formato MIME, codificado em base64url — é o que a função
 * monta aqui dentro, pra quem chamar só precisar passar destinatário,
 * assunto e corpo.
 *
 * @param {{ para: string, assunto: string, corpo: string }} opcoes
 */
export async function enviarEmail({ para, assunto, corpo }) {
  const gmail = google.gmail({ version: 'v1', auth: getClienteGoogle() });

  const mensagemMime = [
    `To: ${para}`,
    `Subject: =?utf-8?B?${Buffer.from(assunto, 'utf-8').toString('base64')}?=`,
    'Content-Type: text/plain; charset="UTF-8"',
    '',
    corpo
  ].join('\n');

  const mensagemCodificada = Buffer.from(mensagemMime)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

  const { data } = await gmail.users.messages.send({
    userId: 'me',
    requestBody: { raw: mensagemCodificada }
  });

  return { id: data.id, enviadoEm: new Date().toISOString() };
}
