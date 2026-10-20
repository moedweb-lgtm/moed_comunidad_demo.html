// Envía por mensaje privado de Discord un código de invitación de un solo uso.
// Variables de entorno (Netlify): DISCORD_BOT_TOKEN, DISCORD_GUILD_ID, FIREBASE_SERVICE_ACCOUNT
const admin = require('firebase-admin');
const crypto = require('crypto');

const API = 'https://discord.com/api/v10';
const COOLDOWN_MS = 10 * 60 * 1000;      // una petición cada 10 min por persona
const VALID_MS = 24 * 60 * 60 * 1000;    // el código caduca a las 24 h

const json = (statusCode, message) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ message })
});

function firestore() {
  if (!admin.apps.length) {
    admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
  }
  return admin.firestore();
}

async function discord(path, opts = {}) {
  const res = await fetch(API + path, {
    ...opts,
    headers: { Authorization: 'Bot ' + process.env.DISCORD_BOT_TOKEN, 'Content-Type': 'application/json' }
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

function newCode() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return 'MOED-' + Array.from(crypto.randomBytes(6), n => A[n % 32]).join('');
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, 'Método no permitido.');
  const { DISCORD_BOT_TOKEN, DISCORD_GUILD_ID, FIREBASE_SERVICE_ACCOUNT } = process.env;
  if (!DISCORD_BOT_TOKEN || !DISCORD_GUILD_ID || !FIREBASE_SERVICE_ACCOUNT) {
    return json(500, 'El servicio de Discord no está configurado.');
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch (_) { return json(400, 'Solicitud no válida.'); }
  const name = String(body.username || '').trim().replace(/^@/, '').replace(/#0$/, '').toLowerCase();
  if (!/^[a-z0-9_.]{2,32}$/.test(name)) return json(400, 'Escribe tu usuario de Discord, sin espacios ni #.');

  try {
    // 1) Buscar a la persona en tu servidor
    const found = await discord(`/guilds/${DISCORD_GUILD_ID}/members/search?query=${encodeURIComponent(name)}&limit=10`);
    if (!found.ok) return json(502, 'No se pudo consultar Discord. Inténtalo más tarde.');
    const member = (found.data || []).find(m => m.user && String(m.user.username).toLowerCase() === name);
    if (!member) return json(404, 'No te encuentro en el servidor de Discord. Únete primero y vuelve a intentarlo.');
    const uid = member.user.id;

    // 2) Límite de peticiones
    const db = firestore();
    const reqRef = db.collection('discordRequests').doc(uid);
    const prev = await reqRef.get();
    if (prev.exists && Date.now() - prev.data().lastAt.toMillis() < COOLDOWN_MS) {
      return json(429, 'Ya te enviamos un código hace poco. Espera unos minutos.');
    }
    await reqRef.set({ lastAt: admin.firestore.Timestamp.now(), name });

    // 3) Borrar códigos anteriores sin usar de esta persona y crear uno nuevo
    const old = await db.collection('inviteCodes').where('discordId', '==', uid).where('uses', '==', 0).get();
    await Promise.all(old.docs.map(d => d.ref.delete()));
    const code = newCode();
    await db.collection('inviteCodes').doc(code).set({
      used: false, maxUses: 1, uses: 0,
      discordId: uid, discordName: name, createdBy: 'discord',
      createdAt: admin.firestore.Timestamp.now(),
      expiresAt: admin.firestore.Timestamp.fromMillis(Date.now() + VALID_MS)
    });

    // 4) Enviar el mensaje privado
    const fail = async (msg) => {
      await db.collection('inviteCodes').doc(code).delete().catch(() => {});
      await reqRef.delete().catch(() => {});
      return json(403, msg);
    };
    const dm = await discord('/users/@me/channels', { method: 'POST', body: JSON.stringify({ recipient_id: uid }) });
    if (!dm.ok) return fail('No pude abrir un mensaje privado contigo.');
    const sent = await discord(`/channels/${dm.data.id}/messages`, {
      method: 'POST',
      body: JSON.stringify({
        content: `Tu código de invitación de MOED+ es: **${code}**\nSirve para un solo registro y caduca en 24 horas. Si no lo pediste tú, ignora este mensaje.`
      })
    });
    if (!sent.ok) {
      return fail('No puedo escribirte. En Discord activa «Mensajes directos» de miembros del servidor (Ajustes del servidor → Privacidad).');
    }
    return json(200, 'Te enviamos el código por mensaje privado de Discord.');
  } catch (e) {
    console.error(e);
    return json(500, 'Error inesperado. Inténtalo de nuevo.');
  }
};
