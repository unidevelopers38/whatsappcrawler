const { Client, LocalAuth } = require('whatsapp-web.js');
const express = require('express');
const app = express();
const port = 3000;

app.use(express.json());

// Store active clients in memory
const clients = {};

// Helper function to initialize a client
const initializeClient = (clientId) => {
    const client = new Client({
        authStrategy: new LocalAuth({ clientId: clientId }),
        puppeteer: { 
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox'] 
        }
    });

    client.status = 'initializing';
    client.qr = null;

    client.on('qr', (qr) => {
        client.status = 'qr_ready';
        client.qr = qr;
    });

    client.on('ready', () => {
        client.status = 'ready';
        client.qr = null;
        console.log(`Client ${clientId} is ready!`);
    });

    client.on('authenticated', () => {
        client.status = 'authenticated';
    });

    client.on('auth_failure', () => {
        client.status = 'failed';
    });

    client.initialize();
    clients[clientId] = client;
};

// 1. Start/Login Session
app.post('/session/start', (req, res) => {
    const { clientId } = req.body;
    if (!clients[clientId]) {
        initializeClient(clientId);
        return res.json({ message: "Initializing...", status: "starting" });
    }
    res.json({ message: "Client already exists", status: clients[clientId].status });
});

// 2. Check Status & Get QR Code
app.get('/session/status/:clientId', (req, res) => {
    const client = clients[req.params.clientId];
    if (!client) return res.status(404).json({ message: "Session not found" });
    
    res.json({
        status: client.status,
        qr: client.qr // Laravel can turn this string into a QR code
    });
});

// 3. Get All Contacts & Groups
app.get('/contacts/:clientId', async (req, res) => {
    const client = clients[req.params.clientId];
    if (!client || client.status !== 'ready') return res.status(400).json({ error: "Client not ready" });

    try {
        const contacts = await client.getContacts();
        // Filters for people and groups
        const data = contacts.map(c => ({
            id: c.id._serialized,
            name: c.name || c.pushname,
            number: c.number,
            isGroup: c.isGroup
        }));
        res.json(data);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 4. Send Message
app.post('/message/send', async (req, res) => {
    const { clientId, to, message } = req.body;
    const client = clients[clientId];

    if (!client || client.status !== 'ready') return res.status(400).json({ error: "Client not ready" });

    try {
        // 'to' should be like '123456789@c.us' or '123456789@g.us'
        await client.sendMessage(to, message);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 5. Delete Session (Logout)
app.delete('/session/:clientId', async (req, res) => {
    const client = clients[req.params.clientId];
    if (client) {
        await client.logout();
        await client.destroy();
        delete clients[req.params.clientId];
        res.json({ message: "Logged out and destroyed" });
    } else {
        res.status(404).json({ message: "Not found" });
    }
});

app.listen(port, () => console.log(`WhatsApp API listening on port ${port}`));