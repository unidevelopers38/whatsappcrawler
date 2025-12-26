const { Client, LocalAuth } = require('whatsapp-web.js');
const express = require('express');
const fs = require('fs');
const path = require('path');
const app = express();
const port = 3000;

app.use(express.json());

// Store active clients in memory
const clients = {};

// Define the sessions directory (where LocalAuth stores session data)
const SESSIONS_DIR = path.join(__dirname, '.wwebjs_auth');

// Function to discover existing sessions
const discoverExistingSessions = () => {
    if (!fs.existsSync(SESSIONS_DIR)) {
        return [];
    }
    
    const sessions = fs.readdirSync(SESSIONS_DIR)
        .filter(folder => {
            // Check if it's a directory and contains required files
            const folderPath = path.join(SESSIONS_DIR, folder);
            if (!fs.statSync(folderPath).isDirectory()) return false;
            
            // Check for session files
            const sessionFiles = fs.readdirSync(folderPath);
            return sessionFiles.some(file => file.includes('session'));
        })
        .map(folder => folder); // folder name is the clientId
    
    console.log(`Found existing sessions: ${sessions.join(', ')}`);
    return sessions;
};

// Helper function to initialize a client
const initializeClient = async (clientId) => {
    // Check if client is already being initialized or exists
    if (clients[clientId] && ['initializing', 'authenticated', 'ready'].includes(clients[clientId].status)) {
        console.log(`Client ${clientId} already exists with status: ${clients[clientId].status}`);
        return clients[clientId];
    }

    console.log(`Initializing client: ${clientId}`);
    
    const client = new Client({
        authStrategy: new LocalAuth({ 
            clientId: clientId,
            dataPath: SESSIONS_DIR
        }),
        puppeteer: { 
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox'] 
        },
        // Add restartOnAuthFail to handle authentication issues
        restartOnAuthFail: true
    });

    client.status = 'initializing';
    client.qr = null;
    client.clientId = clientId;

    client.on('qr', (qr) => {
        console.log(`QR received for client ${clientId}`);
        client.status = 'qr_ready';
        client.qr = qr;
        client.emit('status_change', { status: 'qr_ready', qr });
    });

    client.on('ready', () => {
        console.log(`Client ${clientId} is ready!`);
        client.status = 'ready';
        client.qr = null;
        client.emit('status_change', { status: 'ready' });
        
        // Save session info to a file for persistence across restarts
        saveClientInfo(clientId);
    });

    client.on('authenticated', () => {
        console.log(`Client ${clientId} authenticated`);
        client.status = 'authenticated';
        client.emit('status_change', { status: 'authenticated' });
    });

    client.on('auth_failure', (msg) => {
        console.error(`Authentication failed for client ${clientId}:`, msg);
        client.status = 'auth_failure';
        client.emit('status_change', { status: 'auth_failure' });
    });

    client.on('disconnected', (reason) => {
        console.log(`Client ${clientId} disconnected:`, reason);
        client.status = 'disconnected';
        client.emit('status_change', { status: 'disconnected' });
        
        // Clean up
        setTimeout(() => {
            if (client.status === 'disconnected') {
                delete clients[clientId];
                console.log(`Removed client ${clientId} from memory after disconnect`);
            }
        }, 5000);
    });

    client.on('loading_screen', (percent, message) => {
        console.log(`Client ${clientId} loading: ${percent}% - ${message}`);
        client.status = 'loading';
        client.emit('status_change', { status: 'loading', percent, message });
    });

    try {
        await client.initialize();
        clients[clientId] = client;
        console.log(`Client ${clientId} initialization started`);
        return client;
    } catch (error) {
        console.error(`Failed to initialize client ${clientId}:`, error);
        client.status = 'error';
        client.error = error.message;
        throw error;
    }
};

// Function to save client info for persistence
const saveClientInfo = (clientId) => {
    const infoPath = path.join(SESSIONS_DIR, 'client_info.json');
    let clientInfo = {};
    
    try {
        if (fs.existsSync(infoPath)) {
            const data = fs.readFileSync(infoPath, 'utf8');
            clientInfo = JSON.parse(data);
        }
    } catch (error) {
        console.error('Error reading client info:', error);
        clientInfo = {};
    }
    
    clientInfo[clientId] = {
        lastReady: new Date().toISOString(),
        status: 'ready'
    };
    
    try {
        fs.writeFileSync(infoPath, JSON.stringify(clientInfo, null, 2));
        console.log(`Saved client info for ${clientId}`);
    } catch (error) {
        console.error('Error saving client info:', error);
    }
};

// Initialize all existing sessions on startup
const initializeExistingSessions = async () => {
    console.log('Initializing existing sessions on startup...');
    
    const existingSessions = discoverExistingSessions();
    
    for (const clientId of existingSessions) {
        try {
            await initializeClient(clientId);
            console.log(`Successfully initialized existing session: ${clientId}`);
        } catch (error) {
            console.error(`Failed to initialize session ${clientId}:`, error);
        }
    }
    
    console.log('Session initialization complete');
};

// Health check endpoint
app.get('/health', (req, res) => {
    const activeClients = Object.keys(clients).length;
    const clientStatuses = Object.entries(clients).reduce((acc, [id, client]) => {
        acc[id] = client.status;
        return acc;
    }, {});
    
    res.json({
        status: 'ok',
        activeClients,
        clientStatuses,
        uptime: process.uptime()
    });
});

// 1. Start/Login Session
app.post('/session/start', async (req, res) => {
    try {
        const { clientId } = req.body;
        if (!clientId) {
            return res.status(400).json({ error: "clientId is required" });
        }
        
        const existingClient = clients[clientId];
        if (existingClient) {
            return res.json({ 
                message: "Client already exists", 
                status: existingClient.status,
                clientId 
            });
        }
        
        const client = await initializeClient(clientId);
        res.json({ 
            message: "Initializing...", 
            status: client.status,
            clientId 
        });
    } catch (error) {
        console.error('Error starting session:', error);
        res.status(500).json({ error: error.message });
    }
});

// 2. Check Status & Get QR Code
app.get('/session/status/:clientId', (req, res) => {
    const client = clients[req.params.clientId];
    if (!client) {
        // Check if session exists on disk but not in memory
        const sessionPath = path.join(SESSIONS_DIR, req.params.clientId);
        if (fs.existsSync(sessionPath)) {
            return res.json({
                status: 'disconnected',
                message: "Session exists on disk but not loaded in memory. Use /session/start to reload."
            });
        }
        return res.status(404).json({ message: "Session not found" });
    }
    
    res.json({
        status: client.status,
        qr: client.qr,
        clientId: client.clientId
    });
});

// 3. List all active sessions
app.get('/sessions', (req, res) => {
    const sessions = Object.entries(clients).map(([clientId, client]) => ({
        clientId,
        status: client.status,
        hasQr: !!client.qr
    }));
    
    res.json({
        activeSessions: sessions,
        total: sessions.length
    });
});

// 4. Get All Contacts & Groups
app.get('/contacts/:clientId', async (req, res) => {
    const client = clients[req.params.clientId];
    if (!client || client.status !== 'ready') return res.status(400).json({ error: "Client not ready" });

    try {
        const contacts = await client.getContacts();
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

// 5. Get All Chats
app.get('/chats/:clientId', async (req, res) => {
    const client = clients[req.params.clientId];
    if (!client || client.status !== 'ready') return res.status(400).json({ error: "Client not ready" });

    try {
        const chats = await client.getChats();
        
        const formattedChats = await Promise.all(chats.map(async (chat) => {
            try {
                const messages = await chat.fetchMessages({ limit: 1 });
                const lastMessage = messages.length > 0 ? messages[0] : null;
                
                let contactInfo = {};
                if (!chat.isGroup) {
                    const contact = await client.getContactById(chat.id._serialized);
                    contactInfo = {
                        name: contact.name || contact.pushname || '',
                        number: contact.number || ''
                    };
                }
                
                return {
                    id: chat.id._serialized,
                    name: chat.isGroup ? chat.name : (contactInfo.name || chat.id.user),
                    isGroup: chat.isGroup,
                    isReadOnly: chat.isReadOnly,
                    unreadCount: chat.unreadCount,
                    lastMessage: lastMessage ? {
                        id: lastMessage.id._serialized,
                        body: lastMessage.body,
                        from: lastMessage.from,
                        fromMe: lastMessage.fromMe,
                        timestamp: lastMessage.timestamp,
                        hasMedia: lastMessage.hasMedia,
                        type: lastMessage.type
                    } : null,
                    timestamp: chat.timestamp ? new Date(chat.timestamp * 1000).toISOString() : null,
                    ...(chat.isGroup ? {} : {
                        contactName: contactInfo.name,
                        contactNumber: contactInfo.number
                    })
                };
            } catch (error) {
                console.error(`Error processing chat ${chat.id._serialized}:`, error);
                return null;
            }
        }));
        
        const filteredChats = formattedChats.filter(chat => chat !== null);
        
        filteredChats.sort((a, b) => {
            const timeA = a.timestamp ? new Date(a.timestamp).getTime() : 0;
            const timeB = b.timestamp ? new Date(b.timestamp).getTime() : 0;
            return timeB - timeA;
        });
        
        res.json({
            total: filteredChats.length,
            chats: filteredChats
        });
    } catch (err) {
        console.error('Error fetching chats:', err);
        res.status(500).json({ error: err.message });
    }
});

// 6. Get Messages for a Specific Chat
app.get('/chats/:clientId/:chatId/messages', async (req, res) => {
    const { clientId, chatId } = req.params;
    const { limit = 50 } = req.query;
    
    const client = clients[clientId];
    if (!client || client.status !== 'ready') return res.status(400).json({ error: "Client not ready" });

    try {
        const chat = await client.getChatById(chatId);
        const messages = await chat.fetchMessages({ limit: parseInt(limit) });
        
        const formattedMessages = messages.map(msg => ({
            id: msg.id._serialized,
            body: msg.body,
            from: msg.from,
            fromMe: msg.fromMe,
            timestamp: msg.timestamp,
            hasMedia: msg.hasMedia,
            mediaKey: msg.mediaKey,
            type: msg.type,
            isForwarded: msg.isForwarded,
            isStatus: msg.isStatus,
            links: msg.links,
            mentionedIds: msg.mentionedIds,
            orderId: msg.orderId,
            location: msg.location,
            vCards: msg.vCards
        }));
        
        res.json({
            chatId: chatId,
            chatName: chat.name || chat.id.user,
            isGroup: chat.isGroup,
            totalMessages: messages.length,
            messages: formattedMessages.reverse()
        });
    } catch (err) {
        console.error('Error fetching messages:', err);
        res.status(500).json({ error: err.message });
    }
});

// 7. Send Message
app.post('/message/send', async (req, res) => {
    const { clientId, to, message } = req.body;
    const client = clients[clientId];

    if (!client || client.status !== 'ready') return res.status(400).json({ error: "Client not ready" });

    try {
        await client.sendMessage(to, message);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 8. Send Message to Chat
app.post('/chats/:clientId/:chatId/send', async (req, res) => {
    const { clientId, chatId } = req.params;
    const { message } = req.body;
    
    const client = clients[clientId];
    if (!client || client.status !== 'ready') return res.status(400).json({ error: "Client not ready" });

    try {
        await client.sendMessage(chatId, message);
        res.json({ success: true, chatId });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 9. Delete Session (Logout)
app.delete('/session/:clientId', async (req, res) => {
    const client = clients[req.params.clientId];
    if (client) {
        try {
            // Logout and destroy
            await client.logout();
            await client.destroy();
            
            // Remove session files from disk
            const sessionPath = path.join(SESSIONS_DIR, req.params.clientId);
            if (fs.existsSync(sessionPath)) {
                fs.rmSync(sessionPath, { recursive: true, force: true });
                console.log(`Removed session files for ${req.params.clientId}`);
            }
            
            delete clients[req.params.clientId];
            res.json({ 
                message: "Logged out and session destroyed completely",
                clientId: req.params.clientId 
            });
        } catch (error) {
            console.error('Error during logout:', error);
            res.status(500).json({ error: error.message });
        }
    } else {
        // Check if session exists on disk but not in memory
        const sessionPath = path.join(SESSIONS_DIR, req.params.clientId);
        if (fs.existsSync(sessionPath)) {
            // Remove session files from disk
            fs.rmSync(sessionPath, { recursive: true, force: true });
            return res.json({ 
                message: "Session files removed from disk",
                clientId: req.params.clientId 
            });
        }
        res.status(404).json({ message: "Session not found" });
    }
});

// Graceful shutdown
process.on('SIGINT', async () => {
    console.log('Shutting down gracefully...');
    
    for (const [clientId, client] of Object.entries(clients)) {
        try {
            console.log(`Disconnecting client ${clientId}...`);
            await client.destroy();
        } catch (error) {
            console.error(`Error disconnecting client ${clientId}:`, error);
        }
    }
    
    process.exit(0);
});

// Start the server and initialize existing sessions
app.listen(port, async () => {
    console.log(`WhatsApp API listening on port ${port}`);
    await initializeExistingSessions();
});