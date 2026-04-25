const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const pino = require('pino');
const fetch = require('node-fetch'); // ✅ FIXED

const FIREBASE_URL = process.env.FIREBASE_URL;
const DELIVERY_FEE = 50;

const orderStates = {};

// 🔹 Fetch Menu from Firebase (SAFE)
async function getMenuFromApp() {
    try {
        const response = await fetch(`${FIREBASE_URL}/dishes.json`);

        if (!response.ok) {
            throw new Error("Firebase fetch failed");
        }

        const data = await response.json();
        if (!data) return [];

        return Object.keys(data).map(key => ({
            id: key,
            name: data[key].name,
            price: data[key].price,
            imageUrl: data[key].imageUrl
        }));

    } catch (error) {
        console.error("❌ Menu fetch error:", error);
        return [];
    }
}

async function startBot() {
    if (!FIREBASE_URL) {
        console.log("❌ ERROR: FIREBASE_URL is missing!");
        process.exit(1);
    }

    const { state, saveCreds } = await useMultiFileAuthState('session_data');
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: 'silent' }),
        browser: ["Gamage", "Gems", "1"]
    });

    // 🔹 Connection Handling
    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            console.clear();
            console.log('\n===== GAMAGE-GEMS QR =====\n');
            qrcode.generate(qr, { small: true });
        }

        if (connection === 'open') {
            console.log('✅ Gamage-Gems Bot Online!');
        }

        if (connection === 'close') {
            const reason = lastDisconnect?.error?.output?.statusCode;
            if (reason !== DisconnectReason.loggedOut) {
                console.log("🔄 Reconnecting...");
                startBot();
            }
        }
    });

    sock.ev.on('creds.update', saveCreds);

    // 🔹 Message Handler
    sock.ev.on('messages.upsert', async (m) => {
        try {
            const msg = m.messages[0];
            if (!msg.message || msg.key.remoteJid === 'status@broadcast') return;
            if (msg.key.fromMe) return;

            const sender = msg.key.remoteJid;
            const text = (msg.message.conversation || msg.message.extendedTextMessage?.text || "").toLowerCase().trim();

            console.log(`📩 ${sender}: ${text}`);

            // =========================
            // ✅ STEP 2: FINISH ORDER
            // =========================
            if (orderStates[sender]?.step === 'WAITING_FOR_ADDRESS') {

                if (text.length < 10) {
                    await sock.sendMessage(sender, {
                        text: "❌ Please send valid Name, Phone & Address."
                    });
                    return;
                }

                const item = orderStates[sender].item;
                const customerWaNumber = sender.split('@')[0];
                const price = parseFloat(item.price) || 0;

                const orderData = {
                    userId: "whatsapp_" + customerWaNumber,
                    phone: customerWaNumber,
                    address: text,
                    items: [{
                        id: item.id,
                        name: item.name,
                        price: price,
                        img: item.imageUrl || "",
                        quantity: 1
                    }],
                    total: (price + DELIVERY_FEE).toFixed(2),
                    status: "Placed",
                    method: "Cash on Delivery",
                    timestamp: new Date().toISOString()
                };

                try {
                    await fetch(`${FIREBASE_URL}/orders.json`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(orderData)
                    });
                } catch (err) {
                    console.log("❌ Firebase save error:", err);
                }

                await sock.sendMessage(sender, {
                    text: `✅ *Order Placed!*\n\nItem: *${item.name}*\nTotal: Rs${orderData.total}\n\nWe will deliver soon 🚚`
                });

                delete orderStates[sender];
                return;
            }

            // =========================
            // ✅ STEP 1: START ORDER
            // =========================
            if (text.startsWith("order ")) {

                const productRequested = text.replace("order ", "").trim();
                const menu = await getMenuFromApp();

                const matchedItem = menu.find(
                    item => item.name.toLowerCase().includes(productRequested)
                );

                if (!matchedItem) {
                    await sock.sendMessage(sender, {
                        text: "❌ Item not found. Type *menu*"
                    });
                    return;
                }

                orderStates[sender] = {
                    step: 'WAITING_FOR_ADDRESS',
                    item: matchedItem
                };

                const caption = `🛒 *Order Started*\n\n${matchedItem.name} - Rs${matchedItem.price}\n\nSend Name, Phone & Address`;

                if (matchedItem.imageUrl) {
                    await sock.sendMessage(sender, {
                        image: { url: matchedItem.imageUrl },
                        caption
                    });
                } else {
                    await sock.sendMessage(sender, { text: caption });
                }

                return;
            }

            // =========================
            // 📋 MENU
            // =========================
            if (text.includes("menu") || text.includes("price") || text.includes("list")) {

                const menu = await getMenuFromApp();

                if (menu.length === 0) {
                    await sock.sendMessage(sender, {
                        text: "⚠️ Menu is empty right now."
                    });
                    return;
                }

                let msgText = "📋 *Gamage-Gems Menu*\n\n";

                menu.forEach(item => {
                    msgText += `🔸 ${item.name} - Rs${item.price}\n`;
                });

                msgText += "\n👉 Type: order [item name]";

                await sock.sendMessage(sender, { text: msgText });
                return;
            }

            // =========================
            // 👋 GREETING
            // =========================
            if (text.includes("hi") || text.includes("hello") || text.includes("hey")) {
                await sock.sendMessage(sender, {
                    text: "👋 Welcome to *Gamage-Gems!* \nType *menu* to view items."
                });
                return;
            }

            // =========================
            // 📞 CONTACT
            // =========================
            if (text.includes("contact")) {
                await sock.sendMessage(sender, {
                    text: "📞 Email: sachilagamage@gmail.com"
                });
                return;
            }

            // =========================
            // ❓ DEFAULT
            // =========================
            await sock.sendMessage(sender, {
                text: "🤔 Type *menu* or *order [item]*"
            });

        } catch (err) {
            console.log("❌ Message handling error:", err);
        }
    });
}

startBot().catch(err => console.log("❌ Startup Error:", err));
