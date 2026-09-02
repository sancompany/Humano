/**
 * SAN & CO. — backend/services/googleAuth.js
 * Cliente OAuth2 compartilhado por Drive, Gmail e Agenda — a "autenticação
 * universal" que você pediu. Um login autoriza os três de uma vez, porque
 * os três escopos são pedidos juntos, na mesma tela de consentimento.
 *
 * ADICIONAR UM SERVIÇO NOVO DO GOOGLE NO FUTURO (Fotos, por exemplo) é:
 *   1. Acrescentar o escopo dele em ESCOPOS, abaixo.
 *   2. Rodar `npm run autorizar-google` de novo (o token antigo não cobre
 *      escopo que não foi pedido nele).
 *   3. Criar um driveService.js-like novo, usando getClienteGoogle() daqui.
 * Nada disso mexe em Drive/Gmail/Agenda que já estiverem funcionando.
 *
 * POR QUE ISTO PRECISA DE UM PASSO MANUAL SEU
 *   OAuth2 exige que uma pessoa autorize o acesso pelo menos uma vez,
 *   clicando "Permitir" numa tela do Google — não tem como automatizar
 *   isso com segurança, e não deveria ter. Depois dessa vez, o SDK renova
 *   sozinho (ver o comentário grande abaixo).
 */

import { google } from 'googleapis';

/**
 * Cada escopo é uma permissão específica — não é "acesso total ao Drive",
 * é exatamente isto e nada mais. Se um dia precisar de mais (escrever no
 * Drive, por exemplo, não só ler), o escopo muda aqui e a autorização
 * precisa ser refeita.
 */
export const ESCOPOS = [
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/drive.file',    // aditivo: permite CRIAR pastas/arquivos.
  // Note que readonly e file são ESCOPOS DIFERENTES, não um substituindo o
  // outro: readonly deixa ler QUALQUER arquivo seu no Drive (é o que faz
  // listarArquivosRecentes() funcionar hoje); file só deixa criar/ler o
  // que o próprio app criar — sozinho, ele NUNCA veria os arquivos que já
  // existiam no seu Drive antes do San & Co. existir. Os dois juntos
  // cobrem as duas necessidades sem um atrapalhar o outro.
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/calendar.events'
];

/**
 * Monta o cliente com as credenciais do app (client_id/secret/redirect —
 * fixas, vêm do Google Cloud Console) e, se já existir, o refresh_token
 * (o que representa VOCÊ ter autorizado o app uma vez).
 *
 * @returns {import('googleapis').Auth.OAuth2Client}
 */
export function criarClienteOAuth() {
  const client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );

  if (process.env.GOOGLE_REFRESH_TOKEN) {
    client.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
  }

  return client;
}

/**
 * O cliente pronto pra uso pelos serviços (driveService, gmailService,
 * calendarService). Lança um erro claro se a autorização nunca foi feita,
 * em vez de deixar a chamada real falhar com um erro genérico do Google
 * lá na frente.
 *
 * RENOVAÇÃO DE TOKEN: o SDK oficial (`googleapis`) já cuida disso sozinho
 * — com o refresh_token presente, ele pede um access_token novo ao Google
 * automaticamente antes de expirar, em qualquer chamada. Não precisa de
 * nenhum código nosso pra isso; é o comportamento padrão da biblioteca.
 */
export function getClienteGoogle() {
  if (!process.env.GOOGLE_REFRESH_TOKEN) {
    throw new Error(
      'Google ainda não autorizado. Rode "npm run autorizar-google" no backend/ primeiro.'
    );
  }
  return criarClienteOAuth();
}
