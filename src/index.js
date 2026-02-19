/**
 * OficiosYA — Backend REST API
 * Express + MercadoPago + Expo Push Notifications + Firebase Admin
 *
 * Endpoints:
 *   GET  /                         → Health check
 *   POST /api/mp/preference        → Crea preferencia de pago en MP
 *   GET  /api/mp/payment/:id       → Verifica estado de un pago
 *   POST /api/mp/webhook           → IPN de MercadoPago (llamado por MP)
 *   POST /api/push/send            → Envía push a un usuario por su uid
 *   POST /api/push/job-status      → Notifica cambio de estado de job
 */

'use strict';

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const { Expo } = require('expo-server-sdk');

// ─── Firebase Admin ───────────────────────────────────────────────────────────
const admin = require('firebase-admin');

// En Render se pone el JSON del serviceAccount en la variable FIREBASE_SERVICE_ACCOUNT
// En local se puede usar el archivo descargado directamente
let firebaseApp;
try {
    const serviceAccount =
        process.env.FIREBASE_SERVICE_ACCOUNT
            ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
            : require('../service-account.json'); // fallback local

    firebaseApp = admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
    });
} catch (err) {
    console.error('❌ Firebase Admin init error:', err.message);
    console.warn('⚠️  Continuando sin Firebase Admin. Los endpoints que requieran Firestore fallarán.');
}

const db = firebaseApp ? admin.firestore() : null;

// ─── MercadoPago SDK ──────────────────────────────────────────────────────────
const { MercadoPagoConfig, Preference, Payment } = require('mercadopago');

const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN;
if (!MP_ACCESS_TOKEN) {
    console.error('❌ FATAL: MP_ACCESS_TOKEN no está configurado');
    process.exit(1);
}

function getMPClient() {
    return new MercadoPagoConfig({
        accessToken: MP_ACCESS_TOKEN,
        options: { timeout: 15000 },
    });
}

// ─── Expo Push SDK ────────────────────────────────────────────────────────────
const expo = new Expo({
    accessToken: process.env.EXPO_ACCESS_TOKEN || undefined,
    useFcmV1: true,
});

// ─── Express app ─────────────────────────────────────────────────────────────
const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({ origin: process.env.ALLOWED_ORIGINS || '*' }));
app.use(express.json());

// Logging de requests
app.use((req, _res, next) => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
    next();
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// HELPERS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Obtiene el Expo Push Token de un usuario desde Firestore.
 * @param {string} userId
 * @returns {Promise<string|null>}
 */
async function getExpoPushToken(userId) {
    if (!db) return null;
    try {
        const snap = await db.doc(`users/${userId}`).get();
        return snap.exists ? (snap.data().expoPushToken ?? null) : null;
    } catch (err) {
        console.error('getExpoPushToken error:', err.message);
        return null;
    }
}

/**
 * Envía una o más notificaciones push via Expo.
 * Maneja chunking y errores por dispositivo.
 *
 * @param {string|string[]} tokens
 * @param {string} title
 * @param {string} body
 * @param {object} data
 * @returns {Promise<void>}
 */
async function sendExpoPush(tokens, title, body, data = {}) {
    const tokenList = Array.isArray(tokens) ? tokens : [tokens];
    const validTokens = tokenList.filter(t => t && Expo.isExpoPushToken(t));

    if (validTokens.length === 0) {
        console.warn('⚠️  No hay tokens Expo válidos para notificar');
        return;
    }

    const messages = validTokens.map(to => ({
        to,
        sound: 'default',
        title,
        body,
        data,
        priority: 'high',
        channelId: 'oficiosya-jobs',
    }));

    const chunks = expo.chunkPushNotifications(messages);

    for (const chunk of chunks) {
        try {
            const tickets = await expo.sendPushNotificationsAsync(chunk);
            for (const ticket of tickets) {
                if (ticket.status === 'error') {
                    console.error('Expo ticket error:', ticket.message, ticket.details);
                    if (ticket.details?.error === 'DeviceNotRegistered') {
                        // Limpiar tokens inválidos de Firestore
                        await removeInvalidTokens(validTokens);
                    }
                }
            }
        } catch (err) {
            console.error('sendExpoPush chunk error:', err.message);
        }
    }

    console.log(`📱 Push enviado a ${validTokens.length} dispositivo(s): "${title}"`);
}

/**
 * Elimina tokens inválidos de Firestore.
 * @param {string[]} tokens
 */
async function removeInvalidTokens(tokens) {
    if (!db) return;
    for (const token of tokens) {
        try {
            const snap = await db
                .collection('users')
                .where('expoPushToken', '==', token)
                .get();
            const batch = db.batch();
            snap.docs.forEach(d => batch.update(d.ref, { expoPushToken: admin.firestore.FieldValue.delete() }));
            await batch.commit();
        } catch (err) {
            console.error('removeInvalidTokens error:', err.message);
        }
    }
}

/**
 * Actualiza campos en jobs/{jobId} via Admin SDK (sin reglas de seguridad).
 * @param {string} jobId
 * @param {object} fields
 */
async function updateJob(jobId, fields) {
    if (!db) return;
    await db.doc(`jobs/${jobId}`).update({
        ...fields,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
}

/**
 * Lee un job de Firestore.
 * @param {string} jobId
 * @returns {Promise<object|null>}
 */
async function getJob(jobId) {
    if (!db) return null;
    const snap = await db.doc(`jobs/${jobId}`).get();
    return snap.exists ? { id: snap.id, ...snap.data() } : null;
}

/**
 * Construye las deep link URLs de retorno de MP.
 */
function buildBackUrls(serverUrl) {
    const scheme = process.env.APP_SCHEME || 'oficiosya';
    return {
        success: `${scheme}://payment-result?status=approved`,
        failure: `${scheme}://payment-result?status=rejected`,
        pending: `${scheme}://payment-result?status=pending`,
    };
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ROUTES
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// ── Health check ─────────────────────────────────────────────────────────────
app.get('/', (_req, res) => {
    res.json({
        status: 'ok',
        service: 'OficiosYA API',
        version: '1.0.0',
        timestamp: new Date().toISOString(),
    });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// POST /api/mp/preference
// Crea una preferencia de pago en MercadoPago.
//
// Body: {
//   jobId: string,
//   items: [{ id, title, description, quantity, unit_price, currency_id }],
//   payer: { name, email },
//   statement_descriptor?: string,
//   expires?: boolean,
//   expiration_date_from?: string,
//   expiration_date_to?: string,
// }
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
app.post('/api/mp/preference', async (req, res) => {
    const { jobId, items, payer, statement_descriptor, expires } = req.body;

    if (!jobId || !items?.length || !payer?.email) {
        return res.status(400).json({ error: 'jobId, items y payer.email son requeridos' });
    }

    try {
        const serverUrl = `${req.protocol}://${req.get('host')}`;
        const preferenceClient = new Preference(getMPClient());

        const body = {
            items,
            payer,
            back_urls: buildBackUrls(serverUrl),
            auto_return: 'approved',
            notification_url: `${serverUrl}/api/mp/webhook`,
            external_reference: jobId,
            statement_descriptor: statement_descriptor ?? 'OficiosYA',
            expires: expires ?? false,
            ...(expires && {
                expiration_date_from: req.body.expiration_date_from,
                expiration_date_to: req.body.expiration_date_to,
            }),
        };

        const preference = await preferenceClient.create({ body });

        // Registrar en Firestore (fire-and-forget, no bloquea la respuesta)
        updateJob(jobId, {
            mpPreferenceId: preference.id,
            paymentStatus: 'pending',
        }).catch(err => console.error('Firestore update error:', err.message));

        console.log('✅ Preferencia MP creada:', preference.id, '| jobId:', jobId);

        return res.status(201).json({
            id: preference.id,
            init_point: preference.init_point,
            sandbox_init_point: preference.sandbox_init_point,
        });
    } catch (err) {
        console.error('❌ /api/mp/preference error:', err.message);
        return res.status(500).json({ error: 'Error al crear preferencia', detail: err.message });
    }
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// GET /api/mp/payment/:paymentId
// Verifica el estado de un pago por su ID.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
app.get('/api/mp/payment/:paymentId', async (req, res) => {
    const { paymentId } = req.params;

    try {
        const paymentClient = new Payment(getMPClient());
        const payment = await paymentClient.get({ id: paymentId });

        console.log('🔍 Verificando pago:', paymentId, '| status:', payment.status);

        return res.json({
            id: payment.id,
            status: payment.status,
            status_detail: payment.status_detail,
            transaction_amount: payment.transaction_amount,
            external_reference: payment.external_reference,
            date_approved: payment.date_approved,
        });
    } catch (err) {
        console.error('❌ /api/mp/payment error:', err.message);
        return res.status(500).json({ error: 'Error al verificar pago', detail: err.message });
    }
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// POST /api/mp/webhook
// MercadoPago llama a este endpoint con cada evento IPN.
// MP envía: { type, action, api_version, data: { id }, ... }
//
// IMPORTANTE: responde 200 inmediatamente para que MP no reintente.
// Todo el procesamiento es asíncrono después del res.sendStatus(200).
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
app.post('/api/mp/webhook', async (req, res) => {
    // Responde INMEDIATAMENTE para que MP no reintente (timeout de 5s)
    res.sendStatus(200);

    const { type, data, action } = req.body;
    const paymentId = data?.id ? String(data.id) : null;

    console.log('📨 Webhook MP:', { type, action, paymentId });

    if (type !== 'payment' || !paymentId) return;

    // Procesar de forma asíncrona
    (async () => {
        try {
            const paymentClient = new Payment(getMPClient());
            const payment = await paymentClient.get({ id: paymentId });

            const jobId = payment.external_reference;
            const status = payment.status;
            const transactionAmount = payment.transaction_amount;

            if (!jobId) {
                console.warn('⚠️  Webhook sin external_reference:', paymentId);
                return;
            }

            console.log(`💳 IPN pago ${paymentId} | status: ${status} | jobId: ${jobId}`);

            if (status === 'approved') {
                // 1. Actualizar Firestore
                await updateJob(jobId, {
                    paymentStatus: 'paid',
                    paymentId,
                    paidAt: admin.firestore.FieldValue.serverTimestamp(),
                    totalAmount: transactionAmount,
                });

                // 2. Notificar al worker
                const job = await getJob(jobId);
                if (job?.workerId) {
                    const workerToken = await getExpoPushToken(job.workerId);
                    if (workerToken) {
                        await sendExpoPush(
                            workerToken,
                            '💰 ¡Recibiste un pago!',
                            `${job.clientName ?? 'El cliente'} pagó $${transactionAmount}. El dinero estará en tu cuenta pronto.`,
                            { jobId, type: 'payment_received' }
                        );
                    }
                }

                console.log('✅ Job pagado:', jobId);
            }

            if (status === 'rejected') {
                const job = await getJob(jobId);
                if (job?.clientId) {
                    const clientToken = await getExpoPushToken(job.clientId);
                    if (clientToken) {
                        await sendExpoPush(
                            clientToken,
                            '❌ Pago rechazado',
                            'Tu pago no pudo procesarse. Por favor intentá de nuevo con otro método.',
                            { jobId, type: 'payment_rejected' }
                        );
                    }
                }
            }
        } catch (err) {
            console.error('❌ Webhook processing error:', err.message);
        }
    })();
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// POST /api/push/send
// Envía una push directamente a un usuario por uid.
// La app llama a este endpoint cuando cambia el estado de un job
// para notificar al otro participante (cliente o worker).
//
// Body: {
//   userId: string,          ← uid del destinatario
//   title: string,
//   body: string,
//   data?: object
// }
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
app.post('/api/push/send', async (req, res) => {
    const { userId, title, body, data } = req.body;

    if (!userId || !title || !body) {
        return res.status(400).json({ error: 'userId, title y body son requeridos' });
    }

    try {
        const token = await getExpoPushToken(userId);
        if (!token) {
            return res.status(404).json({ error: 'Usuario sin push token registrado' });
        }

        await sendExpoPush(token, title, body, data ?? {});
        return res.json({ sent: true });
    } catch (err) {
        console.error('❌ /api/push/send error:', err.message);
        return res.status(500).json({ error: 'Error al enviar push', detail: err.message });
    }
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// POST /api/push/job-status
// Notifica automáticamente al destinatario correcto cuando cambia el estado
// de un job. La app llama a este endpoint DESPUÉS de updateDoc en Firestore.
//
// Body: {
//   jobId: string,
//   newStatus: 'accepted' | 'in_progress' | 'completed' | 'cancelled',
//   clientId: string,
//   workerId: string,
//   clientName: string,
//   workerName: string,
//   totalAmount?: number,
//   cancellationReason?: string
// }
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
app.post('/api/push/job-status', async (req, res) => {
    const {
        jobId,
        newStatus,
        clientId,
        workerId,
        clientName,
        workerName,
        totalAmount,
        cancellationReason,
    } = req.body;

    if (!jobId || !newStatus || !clientId || !workerId) {
        return res.status(400).json({ error: 'jobId, newStatus, clientId y workerId son requeridos' });
    }

    // Responder rápido — el push es fire-and-forget
    res.json({ received: true, jobId, newStatus });

    const CONTENT = {
        accepted: {
            to: clientId,
            title: '✅ Solicitud Aceptada',
            body: `${workerName} aceptó tu solicitud. Pronto estará en camino.`,
        },
        in_progress: {
            to: clientId,
            title: '🔧 Trabajo en progreso',
            body: `${workerName} comenzó el trabajo.`,
        },
        completed: {
            to: clientId,
            title: '🎉 Trabajo completado',
            body: totalAmount
                ? `${workerName} finalizó el servicio. Total: $${totalAmount}. Podés pagar y calificar ahora.`
                : `${workerName} finalizó el servicio. ¡Calificalo ahora!`,
        },
        cancelled: {
            to: clientId,
            title: '❌ Solicitud cancelada',
            body: cancellationReason
                ? `${workerName} canceló: "${cancellationReason}". Podés buscar otro profesional.`
                : `${workerName} canceló la solicitud.`,
        },
        // Cuando el worker acepta, también se notifica a él mismo
        accepted_worker: {
            to: workerId,
            title: '💼 Trabajo confirmado',
            body: `Aceptaste el trabajo de ${clientName}. ¡Coordiná los detalles!`,
        },
    };

    (async () => {
        try {
            // Notificar al cliente
            const notif = CONTENT[newStatus];
            if (notif) {
                const token = await getExpoPushToken(notif.to);
                if (token) {
                    await sendExpoPush(token, notif.title, notif.body, { jobId, newStatus });
                }
            }

            // Notificar también al worker cuando acepta
            if (newStatus === 'accepted') {
                const wNotif = CONTENT['accepted_worker'];
                const workerToken = await getExpoPushToken(wNotif.to);
                if (workerToken) {
                    await sendExpoPush(workerToken, wNotif.title, wNotif.body, { jobId, newStatus });
                }
            }
        } catch (err) {
            console.error('❌ job-status push error:', err.message);
        }
    })();
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Error handler global
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
    console.error('Unhandled error:', err);
    res.status(500).json({ error: 'Internal server error', detail: err.message });
});

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
    console.log(`\n🚀 OficiosYA API corriendo en puerto ${PORT}`);
    console.log(`   Health: http://localhost:${PORT}/`);
    console.log(`   MP endpoint: http://localhost:${PORT}/api/mp/preference\n`);
});

module.exports = app;
