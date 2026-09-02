/**
 * SAN & CO. — backend/services/identidade.js
 * Reconhece se quem está falando é o dono da San & Co., pelo número de
 * WhatsApp — pra qualquer agente (Miriel hoje, Lux amanhã) tratar a
 * conversa diferente quando é o próprio dono do outro lado.
 *
 * DONO_WHATSAPP_NUMEROS no .env: um ou mais números, separados por
 * vírgula, sem @s.whatsapp.net (ex.: "5516999998888,5516988887777" — o
 * dono pode falar de mais de um número/aparelho).
 */

/**
 * @param {string} numero — só dígitos, com DDI (o mesmo formato que
 *        extrairMensagem() já produz em routes/whatsapp.js)
 * @returns {boolean}
 */
export function ehDono(numero) {
  if (!numero) return false;
  const numeros = (process.env.DONO_WHATSAPP_NUMEROS || '')
    .split(',')
    .map((n) => n.trim())
    .filter(Boolean);
  return numeros.includes(numero);
}
