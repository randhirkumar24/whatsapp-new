const { Client } = require('./index.js');
const qrcode = require('qrcode-terminal');
const express = require('express');

// Create Express app for health checks
const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Root endpoint
app.get('/', (req, res) => {
    res.json({ 
        message: 'WhatsApp Bot is running!', 
        timestamp: new Date().toISOString(),
        status: 'ok'
    });
});

// Health check endpoint
app.get('/health', (req, res) => {
    res.status(200).json({ 
        status: 'healthy', 
        timestamp: new Date().toISOString(),
        clientReady: client.info ? true : false
    });
});

// Start Express server
app.listen(PORT, (err) => {
    if (err) {
        console.error('Failed to start Express server:', err);
        process.exit(1);
    }
    console.log(`Health check server running on port ${PORT}`);
    console.log(`Health check endpoint: http://localhost:${PORT}/health`);
});

// Create a new client instance
console.log('Creating WhatsApp client...');
const client = new Client();

// When the client is ready, run this code (only once)
client.once('ready', () => {
    console.log('Client is ready!');
});

// When the client received QR-Code
client.on('qr', (qr) => {
    console.log('QR RECEIVED');
    qrcode.generate(qr, {small: true});
});

// Listening to all incoming messages
client.on('message_create', message => {
    console.log('Message received:', message.body);
    
    // Simple ping/pong command
    if (message.body === '!ping') {
        // reply back "pong" directly to the message
        message.reply('pong');
    }
});

// Start your client
client.initialize();
