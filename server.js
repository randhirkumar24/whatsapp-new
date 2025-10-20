const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const { Client, LocalAuth } = require('whatsapp-web.js');
const QRCode = require('qrcode');
const multer = require('multer');
const xlsx = require('xlsx');
const path = require('path');
const fs = require('fs');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Configure multer for file uploads
const upload = multer({
    dest: 'uploads/',
    fileFilter: (req, file, cb) => {
        const allowedTypes = ['.xlsx', '.xls', '.csv', '.jpg', '.jpeg', '.png', '.gif', '.mp4', '.avi', '.mov', '.mkv', '.webm'];
        const fileExtension = path.extname(file.originalname).toLowerCase();
        if (allowedTypes.includes(fileExtension)) {
            cb(null, true);
        } else {
            cb(new Error('Only Excel files (.xlsx, .xls, .csv) and media files (.jpg, .jpeg, .png, .gif, .mp4, .avi, .mov, .mkv, .webm) are allowed!'), false);
        }
    },
    limits: {
        fileSize: 50 * 1024 * 1024 // 50MB limit for media files
    }
});

// WhatsApp Client Configuration
let client = null;
let isClientReady = false;
let isClientAuthenticated = false;
let qrCodeData = null;
let isInitializing = false;
let clientInstanceId = null;

// Campaign State Management
let activeCampaigns = new Map(); // campaignId -> campaign state
let pausedCampaigns = new Map(); // campaignId -> paused campaign state

// No campaign file tracking needed

// Enhanced connection management
let keepAliveInterval = null;
let connectionHealthCheckInterval = null;
let lastSuccessfulConnection = Date.now();
let connectionFailureCount = 0;
const MAX_CONNECTION_FAILURES = 3;

// Campaign health monitoring
let campaignHealthInterval = null;

function startKeepAlive() {
    // Clear any existing keep-alive
    if (keepAliveInterval) {
        clearInterval(keepAliveInterval);
    }
    
    // Enhanced keep-alive every 2 minutes with connection validation
    keepAliveInterval = setInterval(async () => {
        if (client && isClientReady && isClientAuthenticated) {
            try {
                // More comprehensive connection check
                const state = await client.getState();
                if (state === 'CONNECTED') {
                    lastSuccessfulConnection = Date.now();
                    connectionFailureCount = 0;
                    console.log('Keep-alive: Connection healthy, state:', state);
                } else {
                    throw new Error(`Connection state is ${state}, not CONNECTED`);
                }
            } catch (error) {
                connectionFailureCount++;
                console.error(`Keep-alive failed (attempt ${connectionFailureCount}/${MAX_CONNECTION_FAILURES}):`, error.message);
                
                // If keep-alive fails multiple times, force reconnection
                if (connectionFailureCount >= MAX_CONNECTION_FAILURES) {
                    console.log('Multiple keep-alive failures detected, forcing reconnection...');
                    await forceReconnection();
                }
            }
        }
    }, 2 * 60 * 1000); // Reduced to 2 minutes for faster detection
}

function startConnectionHealthCheck() {
    // Clear any existing health check
    if (connectionHealthCheckInterval) {
        clearInterval(connectionHealthCheckInterval);
    }
    
    // Check connection health every 30 seconds
    connectionHealthCheckInterval = setInterval(async () => {
        if (client && isClientReady && isClientAuthenticated) {
            const timeSinceLastSuccess = Date.now() - lastSuccessfulConnection;
            
            // If no successful connection for more than 10 minutes, check health
            if (timeSinceLastSuccess > 10 * 60 * 1000) {
                try {
                    await client.getState();
                    lastSuccessfulConnection = Date.now();
                    connectionFailureCount = 0;
                } catch (error) {
                    console.error('Connection health check failed:', error.message);
                    await forceReconnection();
                }
            }
        }
        
        // Check for stuck campaigns
        checkStuckCampaigns();
    }, 30 * 1000); // 30 seconds
}

function startCampaignHealthMonitoring() {
    // Clear any existing health monitoring
    if (campaignHealthInterval) {
        clearInterval(campaignHealthInterval);
    }
    
    // Monitor campaign health every 5 minutes
    campaignHealthInterval = setInterval(() => {
        const now = Date.now();
        
        for (const [campaignId, campaignState] of activeCampaigns.entries()) {
            if (!campaignState.isPaused) {
                const timeSinceStart = now - campaignState.startedAt.getTime();
                const timeSinceLastActivity = now - (campaignState.lastActivity || campaignState.startedAt.getTime());
                
                // Log campaign status every 5 minutes
                console.log(`📊 Campaign ${campaignId} Status:`);
                console.log(`   ⏱️  Running for: ${Math.floor(timeSinceStart / 60000)} minutes`);
                console.log(`   📈 Progress: ${campaignState.sentCount + campaignState.failedCount}/${campaignState.phoneNumbers.length}`);
                console.log(`   ✅ Sent: ${campaignState.sentCount}`);
                console.log(`   ❌ Failed: ${campaignState.failedCount}`);
                console.log(`   🔄 Last activity: ${Math.floor(timeSinceLastActivity / 60000)} minutes ago`);
                
                // Check for stuck campaigns (no activity for more than 10 minutes)
                if (timeSinceLastActivity > 10 * 60 * 1000) {
                    console.log(`⚠️ Campaign ${campaignId} appears stuck - no activity for ${Math.floor(timeSinceLastActivity / 60000)} minutes`);
                    console.log(`🔄 Attempting to continue campaign...`);
                    
                    // Try to continue the campaign
                    setTimeout(() => {
                        continueCampaign(campaignId).catch(error => {
                            console.error(`❌ Failed to continue stuck campaign ${campaignId}:`, error);
                        });
                    }, 5000);
                }
            }
        }
    }, 5 * 60 * 1000); // 5 minutes
}

async function forceReconnection() {
    console.log('Forcing WhatsApp client reconnection...');
    
    // Stop all intervals
    stopKeepAlive();
    stopConnectionHealthCheck();
    stopCampaignHealthMonitoring();
    
    // Reset states
    isClientReady = false;
    isClientAuthenticated = false;
    connectionFailureCount = 0;
    
    // Emit status update
    io.emit('status', { 
        authenticated: false, 
        ready: false, 
        message: 'Connection lost, reconnecting...' 
    });
    
    // Destroy existing client and reinitialize
    if (client) {
        try {
            await client.destroy();
        } catch (err) {
            console.log('Error destroying client during force reconnection:', err.message);
        }
        client = null;
    }
    
    // Reinitialize after a short delay
    setTimeout(() => {
        initializeWhatsAppClient();
    }, 5000);
}

function stopKeepAlive() {
    if (keepAliveInterval) {
        clearInterval(keepAliveInterval);
        keepAliveInterval = null;
    }
}

function stopCampaignHealthMonitoring() {
    if (campaignHealthInterval) {
        clearInterval(campaignHealthInterval);
        campaignHealthInterval = null;
    }
}

function stopConnectionHealthCheck() {
    if (connectionHealthCheckInterval) {
        clearInterval(connectionHealthCheckInterval);
        connectionHealthCheckInterval = null;
    }
}

// Check for stuck campaigns and restart them
function checkStuckCampaigns() {
    const now = Date.now();
    const stuckThreshold = 5 * 60 * 1000; // 5 minutes
    
    for (const [campaignId, campaignState] of activeCampaigns.entries()) {
        if (!campaignState.isPaused) {
            const timeSinceStart = now - campaignState.startedAt.getTime();
            const timeSinceLastActivity = now - (campaignState.lastActivity || campaignState.startedAt.getTime());
            
            // If campaign has been running for more than 5 minutes without activity
            if (timeSinceLastActivity > stuckThreshold) {
                console.log(`Campaign ${campaignId} appears to be stuck, restarting...`);
                
                // Emit stuck campaign event
                io.emit('campaign_stuck', { 
                    campaignId: campaignId,
                    timeSinceStart: timeSinceStart,
                    timeSinceLastActivity: timeSinceLastActivity
                });
                
                // Restart the campaign
                setTimeout(() => {
                    continueCampaign(campaignId);
                }, 2000);
            }
        }
    }
}

// Enhanced connection validation function
async function validateConnection(strict = true) {
    if (!client) {
        throw new Error('WhatsApp client is not initialized');
    }
    
    if (!isClientReady || !isClientAuthenticated) {
        throw new Error('WhatsApp client is not ready or authenticated');
    }
    
    try {
        // Check if the browser page is still alive
        if (!client.pupPage || client.pupPage.isClosed()) {
            throw new Error('Browser page is closed');
        }
        
        // Check client state
        const state = await client.getState();
        if (state !== 'CONNECTED') {
            if (strict) {
                throw new Error(`Client state is ${state}, not CONNECTED`);
            } else {
                console.warn(`Client state is ${state}, not CONNECTED, but continuing in non-strict mode`);
            }
        }
        
        // Update last successful connection
        lastSuccessfulConnection = Date.now();
        connectionFailureCount = 0;
        
        return true;
    } catch (error) {
        if (strict) {
            connectionFailureCount++;
            console.error(`Connection validation failed (attempt ${connectionFailureCount}/${MAX_CONNECTION_FAILURES}):`, error.message);
            
            // If validation fails multiple times, force reconnection
            if (connectionFailureCount >= MAX_CONNECTION_FAILURES) {
                console.log('Multiple connection validation failures detected, forcing reconnection...');
                await forceReconnection();
            }
        } else {
            console.warn(`Connection validation warning (non-strict mode):`, error.message);
        }
        
        throw error;
    }
}

// Initialize WhatsApp Client
function initializeWhatsAppClient() {
    try {
        // Prevent multiple simultaneous initializations
        if (isInitializing) {
            console.log('Client initialization already in progress, skipping...');
            return;
        }
        
        isInitializing = true;
        clientInstanceId = Date.now().toString();
        
        console.log(`Starting client initialization (Instance: ${clientInstanceId})`);
        
        // Ensure session directory exists
        const sessionDir = './session';
        if (!fs.existsSync(sessionDir)) {
            fs.mkdirSync(sessionDir, { recursive: true });
            console.log('Created session directory');
        }
        
        // Clean up any existing client instance
        if (client) {
            console.log('Cleaning up existing client instance...');
            client.destroy().catch(err => console.log('Error destroying existing client:', err.message));
            client = null;
        }
        
        client = new Client({
            authStrategy: new LocalAuth({
                clientId: 'whatsapp-bulk-sender',
                dataPath: './session'
            }),
            puppeteer: {
                headless: true,
                executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || (process.platform === 'win32' ? undefined : '/usr/bin/chromium-browser'),
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-accelerated-2d-canvas',
                    '--no-first-run',
                    '--no-zygote',
                    '--disable-gpu',
                    '--disable-web-security',
                    '--disable-features=VizDisplayCompositor',
                    '--disable-background-timer-throttling',
                    '--disable-backgrounding-occluded-windows',
                    '--disable-renderer-backgrounding',
                    '--disable-field-trial-config',
                    '--disable-ipc-flooding-protection',
                    '--disable-extensions',
                    '--disable-plugins',
                    '--disable-default-apps',
                    '--disable-sync',
                    '--disable-translate',
                    '--hide-scrollbars',
                    '--mute-audio',
                    '--no-default-browser-check',
                    '--disable-component-extensions-with-background-pages',
                    '--disable-background-networking',
                    '--disable-sync-preferences',
                    '--disable-client-side-phishing-detection',
                    '--disable-component-update',
                    '--disable-domain-reliability',
                    '--disable-features=TranslateUI',
                    '--disable-blink-features=AutomationControlled',
                    '--disable-features=VizDisplayCompositor,VizServiceDisplayCompositor',
                    '--memory-pressure-off',
                    '--max_old_space_size=4096',
                    '--disable-background-networking',
                    '--disable-default-apps',
                    '--disable-extensions',
                    '--disable-sync',
                    '--metrics-recording-only',
                    '--no-first-run',
                    '--safebrowsing-disable-auto-update',
                    '--disable-client-side-phishing-detection',
                    '--disable-component-update',
                    '--disable-domain-reliability',
                    '--disable-features=TranslateUI',
                    '--disable-ipc-flooding-protection',
                    '--disable-renderer-backgrounding',
                    '--disable-backgrounding-occluded-windows',
                    '--disable-background-timer-throttling',
                    '--disable-features=VizDisplayCompositor',
                    '--disable-web-security',
                    '--disable-gpu',
                    '--no-zygote',
                    '--no-first-run',
                    '--disable-accelerated-2d-canvas',
                    '--disable-dev-shm-usage',
                    '--disable-setuid-sandbox',
                    '--no-sandbox'
                ],
                timeout: 60000,
                protocolTimeout: 60000
            },
            webVersion: '2.2412.54',
            webVersionCache: {
                type: 'local'
            },
            restartOnAuthFail: true,
            takeoverOnConflict: false,
            takeoverTimeoutMs: 0,
            qrMaxRetries: 3,
            authTimeoutMs: 60000
        });

        // Event: QR Code received
        client.on('qr', async (qr) => {
            console.log('QR Code received');
            
            // Only update QR code if it's different from the current one
            // This prevents constant QR code updates that can interfere with scanning
            const newQrCodeData = await QRCode.toDataURL(qr);
            
            if (qrCodeData !== newQrCodeData) {
                qrCodeData = newQrCodeData;
                io.emit('qr', qrCodeData);
                io.emit('status', { 
                    authenticated: false, 
                    ready: false, 
                    message: 'Scan QR code with your WhatsApp mobile app' 
                });
                console.log('QR Code updated and sent to client');
            } else {
                console.log('QR Code unchanged, not updating client');
            }
        });

        // Event: Client authenticated
        client.on('authenticated', () => {
            console.log('WhatsApp Client authenticated');
            isClientAuthenticated = true;
            qrCodeData = null;
            io.emit('authenticated', true);
            io.emit('status', { 
                authenticated: true, 
                ready: false, 
                message: 'WhatsApp authenticated, initializing...' 
            });
        });

        // Event: Authentication failed
        client.on('auth_failure', (msg) => {
            console.error('Authentication failed:', msg);
            isClientAuthenticated = false;
            isClientReady = false;
            io.emit('auth_failure', msg);
            io.emit('status', { 
                authenticated: false, 
                ready: false, 
                message: 'Authentication failed: ' + msg 
            });
        });

        // Event: Client ready
        client.on('ready', () => {
            console.log(`WhatsApp Client is ready! (Instance: ${clientInstanceId})`);
            isClientReady = true;
            lastSuccessfulConnection = Date.now();
            connectionFailureCount = 0;
            
            io.emit('ready', true);
            io.emit('status', { 
                authenticated: true, 
                ready: true, 
                message: 'WhatsApp is ready! You can now send messages.' 
            });
            
            // Start enhanced connection management
            startKeepAlive();
            startConnectionHealthCheck();
            startCampaignHealthMonitoring();
        });

        // Event: Loading screen
        client.on('loading_screen', (percent, message) => {
            console.log(`Loading: ${percent}% - ${message}`);
            io.emit('loading_screen', { percent, message });
            io.emit('status', { 
                authenticated: isClientAuthenticated, 
                ready: false, 
                message: `Loading: ${percent}% - ${message}` 
            });
            
            // If stuck at 99% for more than 30 seconds, force ready state
            if (percent >= 99) {
                setTimeout(() => {
                    if (!isClientReady && isClientAuthenticated) {
                        console.log('Loading stuck at 99%, forcing ready state...');
                        isClientReady = true;
                        io.emit('ready', true);
                        io.emit('status', { 
                            authenticated: true, 
                            ready: true, 
                            message: 'WhatsApp is ready! You can now send messages.' 
                        });
                    }
                }, 30000); // 30 second timeout
            }
        });

        // Event: Change state
        client.on('change_state', (state) => {
            console.log('Client state changed to:', state);
            io.emit('state_change', { state });
            
            if (state === 'CONNECTED') {
                console.log('Client connected to WhatsApp Web');
                io.emit('status', { 
                    authenticated: true, 
                    ready: false, 
                    message: 'Connected to WhatsApp Web, initializing...' 
                });
            }
        });

        // Event: Client disconnected
        client.on('disconnected', (reason) => {
            console.log(`WhatsApp Client disconnected: ${reason} (Instance: ${clientInstanceId})`);
            isClientReady = false;
            isClientAuthenticated = false;
            qrCodeData = null;
            isInitializing = false;
            
            // Stop all connection management
            stopKeepAlive();
            stopConnectionHealthCheck();
            stopCampaignHealthMonitoring();
            
            io.emit('disconnected', reason);
            io.emit('status', { 
                authenticated: false, 
                ready: false, 
                message: 'WhatsApp disconnected: ' + reason 
            });
            
            // Only attempt to reconnect for certain disconnect reasons
            const shouldReconnect = reason !== 'NAVIGATION' && reason !== 'LOGOUT';
            
            if (shouldReconnect) {
                console.log('Attempting to reconnect in 10 seconds...');
                setTimeout(() => {
                    if (!isClientAuthenticated && !isInitializing) {
                        console.log('Reinitializing WhatsApp client...');
                        initializeWhatsAppClient();
                    }
                }, 10000); // Reduced delay to 10 seconds for faster recovery
            } else {
                console.log(`Not reconnecting due to reason: ${reason}`);
            }
        });

        // Initialize the client with timeout
        console.log('Starting WhatsApp client initialization...');
        
        // Set a timeout for initialization
        const initTimeout = setTimeout(() => {
            if (!isClientAuthenticated && !isClientReady) {
                console.log('Initialization timeout, destroying and recreating client...');
                if (client) {
                    client.destroy().then(() => {
                        console.log('Client destroyed, reinitializing...');
                        setTimeout(() => {
                            initializeWhatsAppClient();
                        }, 5000);
                    }).catch(err => {
                        console.error('Error destroying client:', err);
                        initializeWhatsAppClient();
                    });
                }
            }
        }, 30000); // Reduced to 30 second timeout for faster recovery
        
        client.initialize().then(() => {
            clearTimeout(initTimeout);
            isInitializing = false;
            console.log(`WhatsApp client initialization completed (Instance: ${clientInstanceId})`);
        }).catch((error) => {
            clearTimeout(initTimeout);
            isInitializing = false;
            console.error('Error during client initialization:', error);
            io.emit('error', 'Failed to initialize WhatsApp client: ' + error.message);
            
            // If initialization fails, try to reinitialize after a delay
            setTimeout(() => {
                if (!isClientReady && !isClientAuthenticated && !isInitializing) {
                    console.log('Retrying client initialization...');
                    initializeWhatsAppClient();
                }
            }, 10000); // Retry after 10 seconds
        });

    } catch (error) {
        console.error('Error initializing WhatsApp client:', error);
        io.emit('error', 'Failed to initialize WhatsApp client');
    }
}

// API Routes

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({ 
        status: 'OK', 
        timestamp: new Date().toISOString(),
        whatsapp: {
            authenticated: isClientAuthenticated,
            ready: isClientReady,
            hasQR: qrCodeData !== null,
            sessionExists: fs.existsSync('./session/whatsapp-bulk-sender')
        }
    });
});

// Get current status
app.get('/api/status', (req, res) => {
    res.json({
        authenticated: isClientAuthenticated,
        ready: isClientReady,
        hasQR: qrCodeData !== null,
        message: getStatusMessage()
    });
});

// Get QR code
app.get('/api/qr', (req, res) => {
    if (qrCodeData) {
        res.json({ qr: qrCodeData });
    } else {
        res.status(404).json({ error: 'No QR code available' });
    }
});

// Logout endpoint
app.post('/api/logout', async (req, res) => {
    try {
        if (client) {
            console.log('Logging out WhatsApp client...');
            await client.logout();
            
            // Reset all states
            isClientReady = false;
            isClientAuthenticated = false;
            qrCodeData = null;
            
            // Destroy the client instance
            await client.destroy();
            client = null;
            
            // Emit logout event
            io.emit('logged_out', true);
            io.emit('status', { 
                authenticated: false, 
                ready: false, 
                message: 'Successfully logged out from WhatsApp' 
            });
            
            // Reinitialize client for new login
            setTimeout(() => {
                initializeWhatsAppClient();
            }, 2000);
            
            res.json({ success: true, message: 'Successfully logged out' });
        } else {
            res.status(400).json({ error: 'No active WhatsApp session to logout' });
        }
    } catch (error) {
        console.error('Error during logout:', error);
        res.status(500).json({ error: 'Failed to logout: ' + error.message });
    }
});

// Force ready endpoint - for troubleshooting stuck authenticated state
app.post('/api/force-ready', async (req, res) => {
    try {
        if (!isClientAuthenticated) {
            return res.status(400).json({ error: 'Client is not authenticated' });
        }
        
        if (isClientReady) {
            return res.json({ success: true, message: 'Client is already ready' });
        }
        
        console.log('Forcing client to ready state...');
        
        // Try to validate client state first
        try {
            if (client) {
                await client.getState();
                console.log('Client state validated successfully');
            }
        } catch (stateError) {
            console.error('Client state validation failed:', stateError.message);
            return res.status(400).json({ error: 'Client is not properly connected to WhatsApp Web. Please try clearing session and reconnecting.' });
        }
        
        // Emit ready event manually
        isClientReady = true;
        io.emit('ready', true);
        io.emit('status', { 
            authenticated: true, 
            ready: true, 
            message: 'WhatsApp is ready! You can now send messages.' 
        });
        
        res.json({ success: true, message: 'Client forced to ready state' });
    } catch (error) {
        console.error('Error forcing ready state:', error);
        res.status(500).json({ error: 'Failed to force ready state: ' + error.message });
    }
});

// Enhanced connection health check endpoint
app.post('/api/check-connection', async (req, res) => {
    try {
        if (!client) {
            return res.status(400).json({ 
                success: false, 
                error: 'Client not initialized',
                recommendation: 'Clear session and reconnect'
            });
        }
        
        if (!isClientAuthenticated) {
            return res.status(400).json({ 
                success: false, 
                error: 'Client not authenticated',
                recommendation: 'Scan QR code to authenticate'
            });
        }
        
        // Enhanced connection validation
        try {
            await validateConnection();
            const state = await client.getState();
            console.log('Enhanced connection check successful:', state);
            
            return res.json({ 
                success: true, 
                message: 'Client connection is healthy',
                state: state,
                authenticated: isClientAuthenticated,
                ready: isClientReady,
                lastSuccessfulConnection: new Date(lastSuccessfulConnection).toISOString(),
                connectionFailureCount: connectionFailureCount
            });
        } catch (validationError) {
            console.error('Enhanced connection check failed:', validationError.message);
            return res.status(400).json({ 
                success: false, 
                error: 'Client connection failed: ' + validationError.message,
                recommendation: 'Connection will be automatically restored. If issues persist, clear session and reconnect.',
                connectionFailureCount: connectionFailureCount
            });
        }
    } catch (error) {
        console.error('Error checking connection:', error);
        res.status(500).json({ error: 'Failed to check connection: ' + error.message });
    }
});

// Clear session endpoint - for troubleshooting stuck connections
app.post('/api/clear-session', async (req, res) => {
    try {
        console.log('Clearing WhatsApp session data...');
        
        // Destroy existing client
        if (client) {
            try {
                await client.destroy();
            } catch (err) {
                console.log('Error destroying client during session clear:', err.message);
            }
            client = null;
        }
        
        // Reset all states
        isClientReady = false;
        isClientAuthenticated = false;
        qrCodeData = null;
        
        // Clear session directory
        const sessionDir = './session';
        if (fs.existsSync(sessionDir)) {
            try {
                fs.rmSync(sessionDir, { recursive: true, force: true });
                console.log('Session directory cleared');
            } catch (err) {
                console.log('Error clearing session directory:', err.message);
            }
        }
        
        // Emit status update
        io.emit('status', { 
            authenticated: false, 
            ready: false, 
            message: 'Session cleared, reinitializing...' 
        });
        
        // Reinitialize client
        setTimeout(() => {
            initializeWhatsAppClient();
        }, 3000);
        
        res.json({ success: true, message: 'Session cleared successfully' });
    } catch (error) {
        console.error('Error clearing session:', error);
        res.status(500).json({ error: 'Failed to clear session: ' + error.message });
    }
});

// Pause campaign endpoint
app.post('/api/campaign/pause', async (req, res) => {
    try {
        const { campaignId } = req.body;
        
        if (!campaignId) {
            return res.status(400).json({ error: 'Campaign ID is required' });
        }
        
        const campaignState = activeCampaigns.get(campaignId);
        if (!campaignState) {
            return res.status(404).json({ error: 'Campaign not found or not active' });
        }
        
        // Pause the campaign
        campaignState.isPaused = true;
        campaignState.pausedAt = new Date();
        
        // Calculate the next message that would be sent
        const nextMessageIndex = campaignState.sentCount + campaignState.failedCount;
        
        // Move to paused campaigns
        pausedCampaigns.set(campaignId, campaignState);
        activeCampaigns.delete(campaignId);
        
        console.log(`Campaign ${campaignId} paused at message ${nextMessageIndex + 1} (sent: ${campaignState.sentCount}, failed: ${campaignState.failedCount})`);
        
        res.json({ 
            success: true, 
            message: 'Campaign paused successfully',
            campaignState: {
                currentIndex: campaignState.currentIndex,
                totalMessages: campaignState.phoneNumbers.length,
                sentCount: campaignState.sentCount,
                failedCount: campaignState.failedCount
            }
        });
        
    } catch (error) {
        console.error('Error pausing campaign:', error);
        res.status(500).json({ error: 'Failed to pause campaign: ' + error.message });
    }
});

// Resume campaign endpoint
app.post('/api/campaign/resume', async (req, res) => {
    try {
        const { campaignId } = req.body;
        
        if (!campaignId) {
            return res.status(400).json({ error: 'Campaign ID is required' });
        }
        
        const campaignState = pausedCampaigns.get(campaignId);
        if (!campaignState) {
            return res.status(404).json({ error: 'Campaign not found or not paused' });
        }
        
        // Resume the campaign
        campaignState.isPaused = false;
        campaignState.resumedAt = new Date();
        campaignState.lastActivity = new Date();
        
        // Move back to active campaigns
        activeCampaigns.set(campaignId, campaignState);
        pausedCampaigns.delete(campaignId);
        
        // Calculate the next message index to send
        const nextMessageIndex = campaignState.sentCount + campaignState.failedCount;
        console.log(`Campaign ${campaignId} resumed from message ${nextMessageIndex + 1} (sent: ${campaignState.sentCount}, failed: ${campaignState.failedCount})`);
        
        // Verify tracking file state before resuming
        const pendingNumbers = getPendingPhoneNumbers(campaignId);
        console.log(`Tracking file shows ${pendingNumbers.length} pending numbers for campaign ${campaignId}`);
        
        // Start sending messages from where it left off
        continueCampaign(campaignId);
        
        res.json({ 
            success: true, 
            message: 'Campaign resumed successfully',
            campaignState: {
                currentIndex: campaignState.currentIndex,
                totalMessages: campaignState.phoneNumbers.length,
                sentCount: campaignState.sentCount,
                failedCount: campaignState.failedCount,
                pendingNumbers: pendingNumbers.length
            }
        });
        
    } catch (error) {
        console.error('Error resuming campaign:', error);
        res.status(500).json({ error: 'Failed to resume campaign: ' + error.message });
    }
});

// Restart stuck campaign endpoint
app.post('/api/campaign/restart', async (req, res) => {
    try {
        const { campaignId } = req.body;
        
        if (!campaignId) {
            return res.status(400).json({ error: 'Campaign ID is required' });
        }
        
        const campaignState = activeCampaigns.get(campaignId);
        if (!campaignState) {
            return res.status(404).json({ error: 'Campaign not found or not active' });
        }
        
        console.log(`Manually restarting campaign ${campaignId}...`);
        
        // Update last activity
        campaignState.lastActivity = new Date();
        
        // Restart the campaign
        continueCampaign(campaignId);
        
        res.json({ 
            success: true, 
            message: 'Campaign restarted successfully',
            campaignState: {
                currentIndex: campaignState.currentIndex,
                totalMessages: campaignState.phoneNumbers.length,
                sentCount: campaignState.sentCount,
                failedCount: campaignState.failedCount
            }
        });
        
    } catch (error) {
        console.error('Error restarting campaign:', error);
        res.status(500).json({ error: 'Failed to restart campaign: ' + error.message });
    }
});

// Get campaign status endpoint
app.get('/api/campaign/:campaignId/status', async (req, res) => {
    try {
        const { campaignId } = req.params;
        
        let campaignState = activeCampaigns.get(campaignId);
        let status = 'active';
        
        if (!campaignState) {
            campaignState = pausedCampaigns.get(campaignId);
            status = 'paused';
        }
        
        if (!campaignState) {
            return res.status(404).json({ error: 'Campaign not found' });
        }
        
        res.json({
            success: true,
            status: status,
            campaignState: {
                currentIndex: campaignState.currentIndex,
                totalMessages: campaignState.phoneNumbers.length,
                sentCount: campaignState.sentCount,
                failedCount: campaignState.failedCount,
                progress: Math.round(((campaignState.sentCount + campaignState.failedCount) / campaignState.phoneNumbers.length) * 100)
            }
        });
        
    } catch (error) {
        console.error('Error getting campaign status:', error);
        res.status(500).json({ error: 'Failed to get campaign status: ' + error.message });
    }
});

// API endpoint to get all active campaigns
app.get('/api/campaigns/active', (req, res) => {
    try {
        const campaigns = [];
        
        // Get active campaigns
        for (const [campaignId, campaignState] of activeCampaigns.entries()) {
            campaigns.push({
                campaignId: campaignId,
                status: 'active',
                progress: {
                    current: campaignState.currentIndex + 1,
                    total: campaignState.phoneNumbers.length,
                    sent: campaignState.sentCount,
                    failed: campaignState.failedCount
                },
                message: campaignState.message,
                delayRange: campaignState.delayRange,
                createdAt: campaignState.createdAt,
                startedAt: campaignState.startedAt,
                lastActivity: campaignState.lastActivity,
                progressPercentage: Math.round(((campaignState.sentCount + campaignState.failedCount) / campaignState.phoneNumbers.length) * 100)
            });
        }
        
        // Get paused campaigns
        for (const [campaignId, campaignState] of pausedCampaigns.entries()) {
            campaigns.push({
                campaignId: campaignId,
                status: 'paused',
                progress: {
                    current: campaignState.currentIndex + 1,
                    total: campaignState.phoneNumbers.length,
                    sent: campaignState.sentCount,
                    failed: campaignState.failedCount
                },
                message: campaignState.message,
                delayRange: campaignState.delayRange,
                createdAt: campaignState.createdAt,
                startedAt: campaignState.startedAt,
                lastActivity: campaignState.lastActivity,
                progressPercentage: Math.round(((campaignState.sentCount + campaignState.failedCount) / campaignState.phoneNumbers.length) * 100)
            });
        }
        
        res.json({ campaigns: campaigns });
    } catch (error) {
        console.error('Error getting active campaigns:', error);
        res.status(500).json({ error: 'Failed to get active campaigns' });
    }
});

// Upload and send messages
app.post('/api/upload-and-send', upload.fields([
    { name: 'mediaFile', maxCount: 1 },
    { name: 'excelFile', maxCount: 1 }
]), async (req, res) => {
    try {
        if (!isClientReady && !isClientAuthenticated) {
            return res.status(400).json({ error: 'WhatsApp client is not ready. Please authenticate first.' });
        }
        
        if (!client) {
            return res.status(400).json({ error: 'WhatsApp client is not initialized. Please try again.' });
        }

        const message = req.body.message || 'Hello! This is a message from WhatsApp Bulk Sender.';
        const fileType = req.body.fileType || 'text'; // 'text', 'excel', or 'media'
        const campaignId = req.body.campaignId || null;
        const delayRange = req.body.delayRange || '1800-3600'; // Default to 30-60 minutes
        
        let phoneNumbers = [];
        let mediaFile = null;

        if (fileType === 'text') {
            // For text messages, we need phone numbers from text input
            const phoneNumbersText = req.body.phoneNumbers;
            if (!phoneNumbersText) {
                return res.status(400).json({ error: 'Phone numbers are required for text messages' });
            }
            
            // Parse phone numbers from text input
            const phoneNumbersList = phoneNumbersText
                .split('\n')
                .map(num => num.trim())
                .filter(num => num.length > 0);
                
            // Validate and format phone numbers
            for (let i = 0; i < phoneNumbersList.length; i++) {
                const formattedNumber = validateAndFormatPhoneNumber(phoneNumbersList[i], i);
                if (formattedNumber) {
                    phoneNumbers.push(formattedNumber);
                }
            }
                
            if (phoneNumbers.length === 0) {
                return res.status(400).json({ error: 'No valid phone numbers found' });
            }
            
        } else if (fileType === 'excel') {
            // For Excel file uploads, we need Excel file
            if (!req.files.excelFile) {
                return res.status(400).json({ error: 'Excel file is required for Excel uploads' });
            }
            
            // Read the uploaded Excel file
            const workbook = xlsx.readFile(req.files.excelFile[0].path);
            const sheetName = workbook.SheetNames[0];
            const worksheet = workbook.Sheets[sheetName];
            const data = xlsx.utils.sheet_to_json(worksheet, { header: 1 });

            // Extract phone numbers (assuming they are in the first column)
            for (let i = 0; i < data.length; i++) {
                if (data[i][0]) {
                    const phoneNumber = data[i][0].toString().trim();
                    const formattedNumber = validateAndFormatPhoneNumber(phoneNumber, i);
                    
                    if (formattedNumber) {
                        phoneNumbers.push(formattedNumber);
                    }
                }
            }

            if (phoneNumbers.length === 0) {
                fs.unlinkSync(req.files.excelFile[0].path);
                return res.status(400).json({ error: 'No valid phone numbers found in the Excel file' });
            }

        } else if (fileType === 'media') {
            // For media messages, we need media file and phone numbers
            if (!req.files.mediaFile) {
                return res.status(400).json({ error: 'Media file is required for media messages' });
            }
            
            // Check if we have phone numbers from text input or Excel file
            const phoneNumbersText = req.body.phoneNumbers;
            if (phoneNumbersText) {
                // Parse phone numbers from text input
                const phoneNumbersList = phoneNumbersText
                    .split('\n')
                    .map(num => num.trim())
                    .filter(num => num.length > 0);
                    
                // Validate and format phone numbers
                for (let i = 0; i < phoneNumbersList.length; i++) {
                    const formattedNumber = validateAndFormatPhoneNumber(phoneNumbersList[i], i);
                    if (formattedNumber) {
                        phoneNumbers.push(formattedNumber);
                    }
                }
                    
                if (phoneNumbers.length === 0) {
                    fs.unlinkSync(req.files.mediaFile[0].path);
                    return res.status(400).json({ error: 'No valid phone numbers found' });
                }
            } else if (req.files.excelFile) {
                // Fallback to Excel file if no text input
                const workbook = xlsx.readFile(req.files.excelFile[0].path);
                const sheetName = workbook.SheetNames[0];
                const worksheet = workbook.Sheets[sheetName];
                const data = xlsx.utils.sheet_to_json(worksheet, { header: 1 });

                // Extract phone numbers (assuming they are in the first column)
                for (let i = 0; i < data.length; i++) {
                    if (data[i][0]) {
                        const phoneNumber = data[i][0].toString().trim();
                        const formattedNumber = validateAndFormatPhoneNumber(phoneNumber, i);
                        
                        if (formattedNumber) {
                            phoneNumbers.push(formattedNumber);
                        }
                    }
                }

                if (phoneNumbers.length === 0) {
                    fs.unlinkSync(req.files.excelFile[0].path);
                    fs.unlinkSync(req.files.mediaFile[0].path);
                    return res.status(400).json({ error: 'No valid phone numbers found in the Excel file' });
                }
            } else {
                fs.unlinkSync(req.files.mediaFile[0].path);
                return res.status(400).json({ error: 'Phone numbers are required for media messages' });
            }
            
            // Create MessageMedia from uploaded file with proper filename handling
            try {
                const { MessageMedia } = require('whatsapp-web.js');
                const originalFilename = req.files.mediaFile[0].originalname;
                const fileExtension = originalFilename.split('.').pop().toLowerCase();
                
                // Determine MIME type based on file extension
                let mimeType;
                switch (fileExtension) {
                    case 'jpg':
                    case 'jpeg':
                        mimeType = 'image/jpeg';
                        break;
                    case 'png':
                        mimeType = 'image/png';
                        break;
                    case 'gif':
                        mimeType = 'image/gif';
                        break;
                    case 'mp4':
                        mimeType = 'video/mp4';
                        break;
                    case 'avi':
                        mimeType = 'video/x-msvideo';
                        break;
                    case 'mov':
                        mimeType = 'video/quicktime';
                        break;
                    case 'mkv':
                        mimeType = 'video/x-matroska';
                        break;
                    case 'webm':
                        mimeType = 'video/webm';
                        break;
                    default:
                        mimeType = 'application/octet-stream';
                }
                
                // Create MessageMedia with proper filename and MIME type
                mediaFile = await MessageMedia.fromFilePath(req.files.mediaFile[0].path);
                
                // Ensure the media file has the correct properties
                if (!mediaFile) {
                    throw new Error('Failed to create MessageMedia object');
                }
                
                // Set proper filename and MIME type
                mediaFile.filename = originalFilename;
                mediaFile.mimetype = mimeType;
                
                // Validate the media file data
                if (!mediaFile.data) {
                    throw new Error('Media file data is missing or corrupted');
                }
                
                console.log(`Processed media file: ${originalFilename} (${mimeType})`);
            } catch (mediaError) {
                fs.unlinkSync(req.files.excelFile[0].path);
                fs.unlinkSync(req.files.mediaFile[0].path);
                return res.status(400).json({ error: 'Failed to process media file: ' + mediaError.message });
            }
        }

        // Clean up uploaded files after processing
        // Note: We need to keep the media file until all messages are sent
        if (req.files.excelFile) {
            fs.unlinkSync(req.files.excelFile[0].path);
        }
        // Don't delete media file yet - we need it for sending messages

        // Store campaign state for pause/resume functionality
        if (campaignId) {
            // No tracking file creation - just send messages directly
            
            const campaignState = {
                campaignId: campaignId,
                phoneNumbers: phoneNumbers,
                message: message,
                mediaFile: mediaFile,
                fileType: fileType,
                delayRange: delayRange,
                currentIndex: 0,
                sentCount: 0,
                failedCount: 0,
                isPaused: false,
                createdAt: new Date(),
                startedAt: new Date(),
                lastActivity: new Date()
            };
            activeCampaigns.set(campaignId, campaignState);
            
            console.log(`💾 Campaign ${campaignId} state saved to server memory`);
            console.log(`🔄 Campaign will run independently of browser connections`);
            console.log(`📱 You can safely close your browser - messages will continue sending`);
        }

        // Send messages with human-like behavior
        const results = [];
        let successCount = 0;
        let failureCount = 0;

        console.log(`Starting to send messages to ${phoneNumbers.length} phone numbers`);
        io.emit('bulk_send_start', { total: phoneNumbers.length, campaignId: campaignId });

        // Start the campaign sending process
        if (campaignId) {
            // Add a small delay to make it easier to test pause functionality
            setTimeout(async () => {
                try {
                    console.log(`🚀 Starting campaign ${campaignId}...`);
                    console.log(`📊 Campaign will process ${phoneNumbers.length} numbers with ${delayRange} delay range`);
                    console.log(`💾 Campaign state stored in server memory - will continue even if browser is closed`);
                    console.log(`⏰ Estimated completion time: ${Math.ceil(phoneNumbers.length * 0.75)} minutes`);
                    
                    await continueCampaign(campaignId);
                } catch (error) {
                    console.error(`❌ Error starting campaign ${campaignId}:`, error);
                    // Emit error event to frontend
                    io.emit('campaign_error', { 
                        campaignId: campaignId, 
                        error: error.message 
                    });
                }
            }, 2000); // 2 second delay
        } else {
            // For non-campaign messages, send immediately
            await sendMessagesSequentially(phoneNumbers, message, campaignId, 0, delayRange, mediaFile);
        }

        // Only emit completion for non-campaign messages (campaign messages will emit completion in sendMessagesSequentially)
        if (!campaignId) {
            io.emit('bulk_send_complete', { 
                total: phoneNumbers.length, 
                success: successCount, 
                failed: failureCount,
                campaignId: campaignId
            });
            
            // Close Chrome browser to save costs after non-campaign messages are sent
            console.log('💰 Non-campaign messages completed - closing Chrome browser to save costs...');
            await closeChromeBrowser();
        }

        // Clean up media file after all messages are sent
        if (req.files && req.files.mediaFile && fs.existsSync(req.files.mediaFile[0].path)) {
            try {
                fs.unlinkSync(req.files.mediaFile[0].path);
                console.log('Media file cleaned up successfully');
            } catch (cleanupError) {
                console.error('Error cleaning up media file:', cleanupError);
            }
        }

        res.json({
            success: true,
            total: phoneNumbers.length,
            successful: successCount,
            failed: failureCount,
            results: results
        });

    } catch (error) {
        console.error('Error processing file and sending messages:', error);
        
        // Clean up uploaded files if they exist
        if (req.files) {
            if (req.files.excelFile && fs.existsSync(req.files.excelFile[0].path)) {
                fs.unlinkSync(req.files.excelFile[0].path);
            }
            if (req.files.mediaFile && fs.existsSync(req.files.mediaFile[0].path)) {
                fs.unlinkSync(req.files.mediaFile[0].path);
            }
        }
        
        res.status(500).json({ error: 'Failed to process file and send messages: ' + error.message });
    }
});

// Helper function to get status message
function getStatusMessage() {
    if (isClientReady) {
        return 'WhatsApp is ready! You can now send messages.';
    } else if (isClientAuthenticated) {
        return 'WhatsApp authenticated, initializing...';
    } else if (qrCodeData) {
        return 'Scan QR code with your WhatsApp mobile app';
    } else if (!client || !client.pupBrowser) {
        return 'Chrome browser is closed to save costs - will reopen automatically when sending messages';
    } else {
        return 'Initializing WhatsApp client...';
    }
}

// Helper function to generate random delay between min and max milliseconds
function getRandomDelay(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

// Helper function to parse delay range from string (e.g., "30-60" -> [30000, 60000])
function parseDelayRange(delayString) {
    const [min, max] = delayString.split('-').map(num => parseInt(num));
    return [min * 1000, max * 1000]; // Convert seconds to milliseconds
}

// Helper function to calculate realistic typing duration based on message length
function calculateTypingDuration(message) {
    // Base typing speed: ~40-60 characters per minute (human average)
    const baseSpeed = getRandomDelay(40, 60); // chars per minute
    const charsPerSecond = baseSpeed / 60;
    
    // Calculate base duration
    const baseDuration = (message.length / charsPerSecond) * 1000;
    
    // Add some randomness and thinking pauses
    const thinkingPauses = Math.floor(message.length / 50) * getRandomDelay(500, 1500); // Pause every ~50 chars
    const randomVariation = baseDuration * (getRandomDelay(80, 120) / 100); // ±20% variation
    
    // Minimum 3 seconds, maximum 30 seconds for very long messages
    const finalDuration = Math.max(3000, Math.min(30000, randomVariation + thinkingPauses));
    
    return Math.floor(finalDuration);
}

// Helper function to simulate human reading time
function calculateReadingTime(message) {
    // Average reading speed: 200-250 words per minute
    const wordsPerMinute = getRandomDelay(200, 250);
    const words = message.split(' ').length;
    const readingTimeMs = (words / wordsPerMinute) * 60 * 1000;
    
    // Minimum 1 second, maximum 10 seconds
    return Math.max(1000, Math.min(10000, readingTimeMs));
}

// Helper function to detect if error indicates number is not available on WhatsApp
function isNumberUnavailableError(error) {
    const errorMessage = error.message.toLowerCase();
    
    // Common patterns that indicate number is not available on WhatsApp
    const unavailablePatterns = [
        'waiting for selector',
        'timeout',
        'navigation timeout',
        'networkidle2',
        'element not found',
        'selector not found',
        'page not found',
        'invalid number',
        'number not found',
        'failed: waiting failed',
        'exceeded',
        'not available',
        'unavailable',
        'invalid phone number',
        'phone number not found'
    ];
    
    // Also check for specific timeout errors that are common with unavailable numbers
    const isTimeoutError = errorMessage.includes('timeout') && 
                          (errorMessage.includes('30000ms') || errorMessage.includes('15000ms'));
    
    return unavailablePatterns.some(pattern => errorMessage.includes(pattern)) || isTimeoutError;
}

// Function to close Chrome browser and save costs
async function closeChromeBrowser() {
    try {
        if (client && client.pupBrowser) {
            console.log('🔒 Closing Chrome browser to save resources...');
            await client.pupBrowser.close();
            client.pupBrowser = null;
            client.pupPage = null;
            isClientReady = false;
            isClientAuthenticated = false;
            console.log('✅ Chrome browser closed successfully');
        }
    } catch (error) {
        console.error('❌ Error closing Chrome browser:', error.message);
    }
}

// Function to ensure Chrome browser is available for sending messages
async function ensureChromeBrowserAvailable() {
    try {
        // Check if browser is available and not closed
        if (!client || !client.pupBrowser || !client.pupPage || client.pupPage.isClosed()) {
            console.log('🔄 Chrome browser not available - reopening with saved session...');
            
            // Clean up any existing client state
            if (client) {
                try {
                    await client.destroy();
                } catch (destroyError) {
                    console.log('Note: Error destroying existing client (expected if already closed):', destroyError.message);
                }
                client = null;
            }
            
            // Reset states
            isClientReady = false;
            isClientAuthenticated = false;
            qrCodeData = null;
            
            // Initialize new client
            await initializeWhatsAppClient();
            
            // Wait for client to be ready
            let attempts = 0;
            const maxAttempts = 30; // 30 seconds timeout
            
            while (!isClientReady && attempts < maxAttempts) {
                await new Promise(resolve => setTimeout(resolve, 1000));
                attempts++;
                console.log(`⏳ Waiting for WhatsApp client to be ready... (${attempts}/${maxAttempts})`);
            }
            
            if (!isClientReady) {
                throw new Error('Failed to initialize WhatsApp client after reopening Chrome - session may need re-authentication');
            }
            
            console.log('✅ Chrome browser reopened successfully with restored session');
        }
    } catch (error) {
        console.error('❌ Error ensuring Chrome browser availability:', error.message);
        throw error;
    }
}

// Puppeteer-based message sending strategy using URL method (text messages only)
// This implements the WhatsApp URL method exactly as in the working test code
async function sendMessageWithPuppeteer(phoneNumber, message, mediaFile = null) {
    try {
        console.log(`Using Puppeteer URL method to send message to ${phoneNumber}`);
        
        // Ensure Chrome browser is available (will reopen if needed)
        await ensureChromeBrowserAvailable();
        
        // Validate client and page
        if (!client || !client.pupPage || client.pupPage.isClosed()) {
            throw new Error('WhatsApp client or page is not available');
        }
        
        // Get the phone number without @c.us suffix for URL
        const cleanPhoneNumber = phoneNumber.replace('@c.us', '');
        
        // For text messages, use URL method
        if (!mediaFile) {
            // Encode the message for URL (exactly as in test code)
            const encodedMessage = encodeURIComponent(message);
            
            // Create WhatsApp Web URL (exactly as in test code)
            const whatsappUrl = `https://web.whatsapp.com/send?phone=${cleanPhoneNumber}&text=${encodedMessage}`;
            
            console.log(`Navigating to WhatsApp URL: ${whatsappUrl}`);
            
            // Navigate to the WhatsApp URL using the existing client's page (exactly as in test code)
            await client.pupPage.goto(whatsappUrl, { waitUntil: 'networkidle2' });
            
            // Wait for the message input box with reduced timeout for faster failure detection
            console.log('Waiting for message input box...');
            const inputBox = await client.pupPage.waitForSelector('div[contenteditable="true"][data-tab="10"]', { timeout: 15000 });
            
            // Wait a bit for the page to fully load (exactly as in test code)
            await client.pupPage.waitForTimeout(3000);
            
            // Send the message by pressing Enter (exactly as in test code)
            console.log('Sending message...');
            await inputBox.press('Enter');
            
            // Wait for message to be sent (exactly as in test code)
            await client.pupPage.waitForTimeout(2000);
            
            console.log(`✓ Message sent successfully to ${phoneNumber} using Puppeteer URL method!`);
            return true;
        } else {
            // For media messages, use direct navigation and file upload
            const whatsappUrl = `https://web.whatsapp.com/send?phone=${cleanPhoneNumber}`;
            
            console.log(`Navigating to WhatsApp URL for media: ${whatsappUrl}`);
            
            // Navigate to the WhatsApp URL
            await client.pupPage.goto(whatsappUrl, { waitUntil: 'networkidle2' });
            
            // Wait for the chat to load
            console.log('Waiting for chat to load...');
            await client.pupPage.waitForSelector('div[contenteditable="true"][data-tab="10"]', { timeout: 30000 });
            
            // Wait a bit for the page to fully load
            await client.pupPage.waitForTimeout(3000);
            
            // Click on the attachment button
            console.log('Clicking attachment button...');
            const attachmentButton = await client.pupPage.waitForSelector('div[data-testid="attach-document"]', { timeout: 10000 });
            await attachmentButton.click();
            
            // Wait for file input
            await client.pupPage.waitForTimeout(1000);
            
            // Upload the media file
            console.log('Uploading media file...');
            const fileInput = await client.pupPage.waitForSelector('input[type="file"]', { timeout: 10000 });
            await fileInput.uploadFile(mediaFile.path);
            
            // Wait for file to be processed
            await client.pupPage.waitForTimeout(3000);
            
            // Add caption if message is provided
            if (message && message.trim()) {
                console.log('Adding caption...');
                const captionInput = await client.pupPage.waitForSelector('div[contenteditable="true"][data-tab="10"]', { timeout: 10000 });
                await captionInput.click();
                await captionInput.type(message);
            }
            
            // Send the message
            console.log('Sending media message...');
            const sendButton = await client.pupPage.waitForSelector('span[data-testid="send"]', { timeout: 10000 });
            await sendButton.click();
            
            // Wait for message to be sent
            await client.pupPage.waitForTimeout(2000);
            
            console.log(`✓ Media message sent successfully to ${phoneNumber} using Puppeteer method!`);
            return true;
        }
        
    } catch (error) {
        console.error(`Error sending message with Puppeteer to ${phoneNumber}:`, error.message);
        throw error;
    }
}

// Helper function to add human-like variations to behavior

// Campaign file management functions
// No tracking file creation needed - campaigns run without file tracking

// No tracking file updates needed

// No pending phone number tracking needed - send to all numbers

// Campaign management functions
async function continueCampaign(campaignId) {
    const campaignState = activeCampaigns.get(campaignId);
    if (!campaignState || campaignState.isPaused) {
        console.log(`Campaign ${campaignId} not found or paused, skipping...`);
        return;
    }
    
    // Check if client is ready before starting campaign
    if (!isClientReady || !isClientAuthenticated) {
        console.log(`Client not ready for campaign ${campaignId}, waiting...`);
        // Wait a bit and try again
        setTimeout(() => {
            continueCampaign(campaignId);
        }, 5000);
        return;
    }
    
    // Send to all numbers in the campaign (no tracking file needed)
    const allPhoneNumbers = campaignState.phoneNumbers;
    
    console.log(`Continuing campaign ${campaignId} with ${allPhoneNumbers.length} numbers`);
    
    // Emit bulk_send_start event for frontend
    io.emit('bulk_send_start', { 
        total: campaignState.phoneNumbers.length, 
        campaignId: campaignId,
        pending: allPhoneNumbers.length,
        sent: campaignState.sentCount,
        failed: campaignState.failedCount
    });
    
    // Start sending messages to all numbers
    await sendMessagesSequentially(
        allPhoneNumbers,
        campaignState.message,
        campaignId,
        0, // Start from beginning
        campaignState.delayRange || '1800-3600',
        campaignState.mediaFile
    );
}

async function sendMessagesSequentially(phoneNumbers, message, campaignId = null, startIndex = 0, delayRange = "1800-3600", mediaFile = null) {
    const results = [];
    let successCount = 0;
    let failureCount = 0;
    
    for (let i = 0; i < phoneNumbers.length; i++) {
        const phoneNumber = phoneNumbers[i];
        const currentIndex = startIndex + i;
        
        // Check if campaign is paused
        if (campaignId) {
            const campaignState = activeCampaigns.get(campaignId);
            if (!campaignState || campaignState.isPaused) {
                console.log(`Campaign ${campaignId} is paused, stopping at message ${currentIndex + 1}`);
                return;
            }
            
            // Update current index in campaign state
            campaignState.currentIndex = currentIndex;
            
            // No tracking file verification - send to all numbers
        }
        
        try {
            // Enhanced connection validation before proceeding
            await validateConnection();

            // Human behavior: Random delay before starting interaction (5-15 seconds)
            // Only add pre-delay if this is not the first message of the campaign OR if we're resuming
            if (i > 0 || startIndex > 0) {
                const preDelay = getRandomDelay(5000, 15000);
                console.log(`Waiting ${preDelay/1000}s before processing next number...`);
                
                io.emit('human_behavior', {
                    number: phoneNumber,
                    action: 'waiting',
                    duration: preDelay,
                    progress: currentIndex + 1,
                    total: phoneNumbers.length + startIndex,
                    campaignId: campaignId
                });
                
                await new Promise(resolve => setTimeout(resolve, preDelay));
            }

            // Use Puppeteer URL method directly (no registration check, no typing indicators)
            console.log(`Sending message to ${phoneNumber} using URL method...`);
            
            let messageSent = false;
            let sendAttempts = 0;
            // Smart retry logic: only retry for connection issues, not for unavailable numbers
            const maxAttempts = 3;
            let shouldRetry = true;
            
            while (!messageSent && sendAttempts < maxAttempts && shouldRetry) {
                try {
                    sendAttempts++;
                    console.log(`Send attempt ${sendAttempts}/${maxAttempts} for ${phoneNumber}`);
            
                    // Use Puppeteer URL method for sending messages (text or media)
                    await sendMessageWithPuppeteer(phoneNumber, message, mediaFile);
                    
                    messageSent = true;
                    console.log(`Message sent successfully to ${phoneNumber}`);
                    
                } catch (sendError) {
                    console.error(`Send attempt ${sendAttempts} failed for ${phoneNumber}:`, sendError.message);
                    
                    // Check if this is a "number not available" error
                    if (isNumberUnavailableError(sendError)) {
                        console.log(`⚠️ Number ${phoneNumber} appears to be unavailable on WhatsApp - skipping retries`);
                        shouldRetry = false; // Don't retry for unavailable numbers
                        throw new Error(`Number not available on WhatsApp: ${sendError.message}`);
                    }
                    
                    // Only retry for connection/network issues
                    if (sendAttempts < maxAttempts && shouldRetry) {
                        // Wait before retry
                        const retryDelay = getRandomDelay(2000, 5000);
                        console.log(`Retrying in ${retryDelay/1000}s...`);
                        await new Promise(resolve => setTimeout(resolve, retryDelay));
                        
                        // Re-validate connection before retry
                        try {
                            await validateConnection();
                        } catch (stateError) {
                            console.error('Connection validation failed during retry:', stateError.message);
                            throw new Error('WhatsApp client connection lost during retry');
                        }
                    } else {
                        throw sendError;
                    }
                }
            }
            
            results.push({ number: phoneNumber, status: 'sent', error: null });
            successCount++;
            
            // Update campaign state
            if (campaignId) {
                const campaignState = activeCampaigns.get(campaignId);
                if (campaignState) {
                    campaignState.sentCount++;
                    campaignState.lastActivity = new Date();
                }
            }
            
            io.emit('message_sent', { 
                number: phoneNumber, 
                status: 'sent', 
                progress: currentIndex + 1, 
                total: phoneNumbers.length + startIndex,
                campaignId: campaignId
            });
            
            // Human behavior: Random delay between messages (configurable)
            if (i < phoneNumbers.length - 1) { // Don't delay after the last message
                const [minDelay, maxDelay] = parseDelayRange(delayRange);
                const humanDelay = getRandomDelay(minDelay, maxDelay);
                console.log(`Human-like delay: waiting ${humanDelay/1000}s before next message...`);
                
                io.emit('human_behavior', {
                    number: phoneNumber,
                    action: 'human_delay',
                    duration: humanDelay,
                    progress: currentIndex + 1,
                    total: phoneNumbers.length + startIndex,
                    nextNumber: phoneNumbers[i + 1],
                    campaignId: campaignId
                });
                
                // Show as away/inactive during long delay
                try {
                    await client.sendPresenceUnavailable();
                } catch (err) {
                    console.log('Could not set presence unavailable (non-critical):', err.message);
                }
                
                await new Promise(resolve => setTimeout(resolve, humanDelay));
            }
            
        } catch (error) {
            console.error(`Error sending message to ${phoneNumber}:`, error);
            
            // Categorize the error for better tracking
            let errorCategory = 'failed';
            let errorMessage = error.message;
            
            if (isNumberUnavailableError(error)) {
                errorCategory = 'unavailable';
                errorMessage = 'Number not available on WhatsApp';
                console.log(`📱 Number ${phoneNumber} is not available on WhatsApp`);
            } else if (error.message.includes('connection') || error.message.includes('timeout')) {
                errorCategory = 'connection';
                console.log(`🔌 Connection issue for ${phoneNumber}`);
            } else {
                console.log(`❌ General error for ${phoneNumber}: ${error.message}`);
            }
            
            results.push({ number: phoneNumber, status: errorCategory, error: errorMessage });
            failureCount++;
            
            // Update campaign state
            if (campaignId) {
                const campaignState = activeCampaigns.get(campaignId);
                if (campaignState) {
                    campaignState.failedCount++;
                    campaignState.lastActivity = new Date();
                }
            }
            
            io.emit('message_sent', { 
                number: phoneNumber, 
                status: errorCategory, 
                error: errorMessage,
                progress: currentIndex + 1, 
                total: phoneNumbers.length + startIndex,
                campaignId: campaignId
            });
        }
    }
    
    // Campaign completed
    if (campaignId) {
        const campaignState = activeCampaigns.get(campaignId);
        if (campaignState) {
            // Calculate failure breakdown
            const unavailableCount = results.filter(r => r.status === 'unavailable').length;
            const connectionCount = results.filter(r => r.status === 'connection').length;
            const generalCount = results.filter(r => r.status === 'failed').length;
            
            // Log campaign summary
            console.log(`\n📊 Campaign ${campaignId} Summary:`);
            console.log(`✅ Successfully sent: ${campaignState.sentCount}`);
            console.log(`📱 Unavailable numbers: ${unavailableCount}`);
            console.log(`🔌 Connection issues: ${connectionCount}`);
            console.log(`❌ General failures: ${generalCount}`);
            console.log(`📈 Total processed: ${campaignState.phoneNumbers.length}`);
            
            // Remove from active campaigns
            activeCampaigns.delete(campaignId);
            
            // Emit completion event with detailed breakdown
            io.emit('bulk_send_complete', { 
                total: campaignState.phoneNumbers.length, 
                success: campaignState.sentCount, 
                failed: campaignState.failedCount,
                unavailable: unavailableCount,
                connection: connectionCount,
                general: generalCount,
                campaignId: campaignId
            });
            
            // Clean up media file if it exists
            if (campaignState.mediaFile && campaignState.mediaFile.path) {
                try {
                    fs.unlinkSync(campaignState.mediaFile.path);
                    console.log('Media file cleaned up successfully');
                } catch (cleanupError) {
                    console.error('Error cleaning up media file:', cleanupError);
                }
            }
            
            // Campaign completed - no tracking file needed
            
            // Close Chrome browser to save costs after campaign completion
            console.log('💰 Campaign completed - closing Chrome browser to save costs...');
            await closeChromeBrowser();
        }
    }
    
    return { successCount, failureCount, results };
}
function addHumanVariation() {
    // Occasionally add extra delays to simulate distractions
    const shouldAddDistraction = Math.random() < 0.1; // 10% chance
    if (shouldAddDistraction) {
        return getRandomDelay(5000, 20000); // 5-20 second distraction
    }
    return 0;
}

// Helper function to validate and format phone numbers
function validateAndFormatPhoneNumber(phoneNumber, rowIndex) {
    // Skip if this looks like a header (contains letters and is not a valid phone number)
    if (rowIndex === 0 && /[a-zA-Z]/.test(phoneNumber) && !/^\d+$/.test(phoneNumber.replace(/[+\-\s]/g, ''))) {
        console.log('Skipping header row:', phoneNumber);
        return null;
    }
    
    // Validate that it's actually a phone number
    const cleanNumber = phoneNumber.replace(/[+\-\s]/g, '');
    if (!/^\d+$/.test(cleanNumber)) {
        console.log('Skipping invalid phone number:', phoneNumber);
        return null;
    }
    
    // Additional validation: ensure minimum length
    if (cleanNumber.length < 10) {
        console.log('Skipping phone number too short:', phoneNumber);
        return null;
    }
    
    // Format phone number: ensure it starts with country code
    if (phoneNumber.startsWith('91') && phoneNumber.length === 12) {
        return phoneNumber + '@c.us';
    } else if (phoneNumber.startsWith('+91')) {
        return phoneNumber.substring(1) + '@c.us';
    } else if (phoneNumber.length === 10) {
        return '91' + phoneNumber + '@c.us';
    } else {
        return phoneNumber + '@c.us';
    }
}

// Socket.IO connection handling
io.on('connection', (socket) => {
    console.log('Client connected:', socket.id);
    
    // Send current status to newly connected client
    socket.emit('status', {
        authenticated: isClientAuthenticated,
        ready: isClientReady,
        message: getStatusMessage()
    });
    
    // Send QR code if available
    if (qrCodeData) {
        socket.emit('qr', qrCodeData);
    }
    
    socket.on('disconnect', () => {
        console.log('Client disconnected:', socket.id);
    });
});

// Serve the main HTML page (redirects to login)
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Serve the login page
app.get('/login', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// Serve the dashboard page
app.get('/dashboard', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    console.log('Initializing WhatsApp client...');
    initializeWhatsAppClient();
});

// Graceful shutdown
process.on('SIGINT', async () => {
    console.log('Shutting down gracefully...');
    if (client) {
        await client.destroy();
    }
    process.exit(0);
});
