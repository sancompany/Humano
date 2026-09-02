/**
 * SAN & CO. — backend/services/driveService.js
 * Leitura do Drive. Escopo hoje é só `drive.readonly` (ver googleAuth.js)
 * — nada aqui escreve ou apaga nada na sua conta.
 */

import { google } from 'googleapis';
import { getClienteGoogle } from './googleAuth.js';

/**
 * Lista os arquivos mais recentes do Drive.
 * @param {number} limite quantos arquivos trazer (padrão 10)
 * @returns {Promise<Array<{ id, nome, tipo, modificadoEm, link }>>}
 */
export async function listarArquivosRecentes(limite = 10) {
  const drive = google.drive({ version: 'v3', auth: getClienteGoogle() });

  const { data } = await drive.files.list({
    pageSize: limite,
    orderBy: 'modifiedTime desc',
    fields: 'files(id, name, mimeType, modifiedTime, webViewLink)'
  });

  return (data.files ?? []).map((arquivo) => ({
    id: arquivo.id,
    nome: arquivo.name,
    tipo: arquivo.mimeType,
    modificadoEm: arquivo.modifiedTime,
    link: arquivo.webViewLink
  }));
}
