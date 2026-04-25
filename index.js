const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const pino = require('pino');
const fetch = require('node-fetch'); // ✅ Added

const FIREBASE_URL = process.env.FIREBASE_URL;

const orderStates = {}; 

async function getMenuFromApp() {
    try {
        const response = await fetch(`${FIREBASE_URL}/dishes.json`);
        const data = await response.json();
        if (!data) return [];
        
        return Object.keys(data).map(key => ({
            id: key,
            name: data[key].name,
            price: data[key].price,
            imageUrl: data[key].imageUrl
        }));
    } catch (error) {
        console.error("Failed to fetch menu:", error);
        return [];
    }
}

async function startBot() {
    if (!FIREBASE_URL) {
        console.log("❌ ERROR: FIREBASE_URL is missing!");
        process.exit(1);
    }

    const { state, saveCreds } = await useMultiFileAuthState('gamage_session');
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: 'silent' }),
        browser: ["Gamage", "Gems", "1"] 
    });

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            console.clear(); 
            console.log('\n===== GAMAGE-GEMS QR =====\n');
            qrcode.generate(qr, { small: true }); 
        }

        if (connection === 'open') console.log('✅ Gamage-Gems Bot Online!');
        if (connection === 'close') {
            const reason = lastDisconnect?.error?.output?.statusCode;
            if (reason !== DisconnectReason.loggedOut) startBot();
        }
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('messages.upsert', async (m) => {
        const msg = m.messages[0];
        if (!msg.message || msg.key.remoteJid === 'status@broadcast') return;
        if (msg.key.fromMe) return;

        const sender = msg.key.remoteJid;
        const text = (msg.message.conversation || msg.message.extendedTextMessage?.text || "").toLowerCase();

        // ORDER COMPLETE
        if (orderStates[sender]?.step === 'WAITING_FOR_ADDRESS') {
            const customerDetails = text;
            const item = orderStates[sender].item;
            const customerWaNumber = sender.split('@')[0];

            const DELIVERY_FEE = 50;
            const price = parseFloat(item.price) || 0;

            const order = {
                userId: "whatsapp_" + customerWaNumber,
                phone: customerWaNumber,
                address: customerDetails,
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

            await fetch(`${FIREBASE_URL}/orders.json`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(order)
            });

            await sock.sendMessage(sender, {
                text: `✅ *Gamage-Gems Order Confirmed!*\n\nItem: *${item.name}*\nTotal: Rs${order.total}`
            });

            delete orderStates[sender];
            return;
        }

        // START ORDER
        if (text.startsWith("order ")) {
            const productRequested = text.replace("order ", "").trim();
            const menu = await getMenuFromApp();

            const item = menu.find(i => i.name.toLowerCase().includes(productRequested));

            if (!item) {
                await sock.sendMessage(sender, { text: "❌ Item not found. Type *menu*" });
                return;
            }

            orderStates[sender] = { step: 'WAITING_FOR_ADDRESS', item };

            const caption = `🛒 *Gamage-Gems Order*\n\n${item.name} - Rs${item.price}\n\nSend Name, Phone, Address`;

            if (item.imageUrl) {
                await sock.sendMessage(sender, { image: { url: item.imageUrl }, caption });
            } else {
                await sock.sendMessage(sender, { text: caption });
            }
        }

        // MENU
        else if (text.includes("menu")) {
            const menu = await getMenuFromApp();

            let msgText = "📋 *Gamage-Gems Menu*\n\n";
            menu.forEach(i => msgText += `• ${i.name} - Rs${i.price}\n`);

            await sock.sendMessage(sender, { text: msgText });
        }

        // GREETING
        else if (text.includes("hi") || text.includes("hello")) {
            await sock.sendMessage(sender, {
                text: "👋 Welcome to *Gamage-Gems*! Type *menu* to view items."
            });
        }
    });
}

startBot();
