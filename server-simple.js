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

// Simple WhatsApp Client Configuration
let client = null;
let isClientReady = false;
let isClientAuthenticated = false;
let qrCodeData = null;

// Campaign State Management
let activeCampaigns = new Map();
let pausedCampaigns = new Map();
let campaignFiles = new Map();

// Initialize WhatsApp client
async function initializeWhatsAppClient() {
    try {
        // Ensure session directory exists
        if (!fs.existsSync('./session')) {
            fs.mkdirSync('./session', { recursive: true });
        }

        client = new Client({
            authStrategy: new LocalAuth({
                dataPath: './session'
            }),
            puppeteer: {
                headless: true,
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-gpu',
                    '--no-first-run'
                ]
            }
        });

        // Event: QR Code received
        client.on('qr', async (qr) => {
            console.log('QR Code received');
            qrCodeData = await QRCode.toDataURL(qr);
            isClientAuthenticated = false;
            isClientReady = false;
            io.emit('qr', qrCodeData);
            io.emit('status', { 
                authenticated: false, 
                ready: false, 
                message: 'Scan QR code with your WhatsApp mobile app' 
            });
        });

        // Event: Client authenticated
        client.on('authenticated', () => {
            console.log('WhatsApp Client authenticated');
            isClientAuthenticated = true;
            qrCodeData = null;
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
            qrCodeData = null;
            io.emit('status', { 
                authenticated: false, 
                ready: false, 
                message: 'Authentication failed: ' + msg 
            });
        });

        // Event: Client ready
        client.on('ready', () => {
            console.log('WhatsApp Client is ready!');
            isClientReady = true;
            isClientAuthenticated = true;
            qrCodeData = null;
            io.emit('status', { 
                authenticated: true, 
                ready: true, 
                message: 'WhatsApp is ready! You can now send messages.' 
            });
        });

        // Event: Client disconnected
        client.on('disconnected', (reason) => {
            console.log('WhatsApp Client disconnected:', reason);
            isClientReady = false;
            isClientAuthenticated = false;
            qrCodeData = null;
            io.emit('status', { 
                authenticated: false, 
                ready: false, 
                message: 'WhatsApp disconnected: ' + reason 
            });
        });

        // Initialize the client
        console.log('Starting WhatsApp client initialization...');
        await client.initialize();
        console.log('WhatsApp client initialization completed');

    } catch (error) {
        console.error('Error initializing WhatsApp client:', error);
        io.emit('status', { 
            authenticated: false, 
            ready: false, 
            message: 'Error initializing WhatsApp: ' + error.message 
        });
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
            hasQR: qrCodeData !== null
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
            await client.destroy();
            client = null;
            isClientReady = false;
            isClientAuthenticated = false;
            qrCodeData = null;
            
            io.emit('logged_out');
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

// Upload and send messages
app.post('/api/upload-and-send', upload.fields([
    { name: 'mediaFile', maxCount: 1 },
    { name: 'excelFile', maxCount: 1 }
]), async (req, res) => {
    try {
        if (!client || !isClientReady) {
            return res.status(400).json({ error: 'WhatsApp is not ready. Please connect and authenticate first.' });
        }

        const message = req.body.message || 'Hello! This is a message from WhatsApp Bulk Sender.';
        const fileType = req.body.fileType || 'text';
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
            if (!req.files.excelFile) {
                return res.status(400).json({ error: 'Excel file is required for Excel uploads' });
            }
            
            const workbook = xlsx.readFile(req.files.excelFile[0].path);
            const sheetName = workbook.SheetNames[0];
            const worksheet = workbook.Sheets[sheetName];
            const data = xlsx.utils.sheet_to_json(worksheet, { header: 1 });

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
            
            try {
                const { MessageMedia } = require('whatsapp-web.js');
                const originalFilename = req.files.mediaFile[0].originalname;
                const fileExtension = originalFilename.split('.').pop().toLowerCase();
                
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
                
                mediaFile = await MessageMedia.fromFilePath(req.files.mediaFile[0].path);
                mediaFile.filename = originalFilename;
                mediaFile.mimetype = mimeType;
                
                console.log(`Processed media file: ${originalFilename} (${mimeType})`);
            } catch (mediaError) {
                fs.unlinkSync(req.files.excelFile[0].path);
                fs.unlinkSync(req.files.mediaFile[0].path);
                return res.status(400).json({ error: 'Failed to process media file: ' + mediaError.message });
            }
        }

        // Clean up uploaded files after processing
        if (req.files.excelFile) {
            fs.unlinkSync(req.files.excelFile[0].path);
        }

        // Store campaign state for pause/resume functionality
        if (campaignId) {
            // Create tracking file for this campaign
            let trackingFilePath;
            if (req.files && req.files.excelFile) {
                trackingFilePath = req.files.excelFile[0].path;
            } else {
                // For text input, create a temporary tracking file
                trackingFilePath = `./temp_${campaignId}_tracking.xlsx`;
            }
            createTrackingFile(campaignId, phoneNumbers, trackingFilePath);
            
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
                startedAt: new Date()
            };
            activeCampaigns.set(campaignId, campaignState);
        }

        console.log(`Starting to send messages to ${phoneNumbers.length} phone numbers`);
        io.emit('bulk_send_start', { total: phoneNumbers.length, campaignId: campaignId });

        // Start the campaign sending process
        if (campaignId) {
            setTimeout(() => {
                continueCampaign(campaignId);
            }, 2000);
        } else {
            await sendMessagesSequentially(phoneNumbers, message, mediaFile, campaignId, 0, delayRange);
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
            total: phoneNumbers.length
        });

    } catch (error) {
        console.error('Error processing file and sending messages:', error);
        
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
    } else {
        return 'Initializing WhatsApp client...';
    }
}

// Helper function to generate random delay
function getRandomDelay(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

// Helper function to parse delay range from string (e.g., "30-60" -> [30000, 60000])
function parseDelayRange(delayString) {
    const [min, max] = delayString.split('-').map(num => parseInt(num));
    return [min * 1000, max * 1000]; // Convert seconds to milliseconds
}

// Campaign file management functions
function createTrackingFile(campaignId, phoneNumbers, originalFilePath) {
    try {
        let finalTrackingPath;
        
        // Check if this is a temporary file path (for text input)
        if (originalFilePath.startsWith('./temp_')) {
            finalTrackingPath = originalFilePath;
        } else {
            // Create a copy of the original file for tracking
            const trackingPath = originalFilePath.replace('.xlsx', '_tracking.xlsx');
            const trackingPath2 = originalFilePath.replace('.xls', '_tracking.xlsx');
            const trackingPath3 = originalFilePath.replace('.csv', '_tracking.xlsx');
            
            finalTrackingPath = trackingPath;
            if (fs.existsSync(trackingPath2)) finalTrackingPath = trackingPath2;
            if (fs.existsSync(trackingPath3)) finalTrackingPath = trackingPath3;
        }
        
        const workbook = xlsx.utils.book_new();
        const trackingData = phoneNumbers.map((phone, index) => ({
            'Phone Number': phone.replace('@c.us', ''),
            'Status': 'Pending',
            'Sent At': '',
            'Error': ''
        }));
        
        const worksheet = xlsx.utils.json_to_sheet(trackingData);
        xlsx.utils.book_append_sheet(workbook, worksheet, 'Tracking');
        xlsx.writeFile(workbook, finalTrackingPath);
        
        campaignFiles.set(campaignId, {
            originalPath: originalFilePath,
            trackingPath: finalTrackingPath
        });
        
        console.log(`Created tracking file for campaign ${campaignId}: ${finalTrackingPath}`);
        return finalTrackingPath;
    } catch (error) {
        console.error('Error creating tracking file:', error);
        return null;
    }
}

function updateTrackingFile(campaignId, phoneNumber, status, error = '') {
    try {
        const fileInfo = campaignFiles.get(campaignId);
        if (!fileInfo || !fs.existsSync(fileInfo.trackingPath)) {
            return false;
        }
        
        const workbook = xlsx.readFile(fileInfo.trackingPath);
        const worksheet = workbook.Sheets[workbook.SheetNames[0]];
        const data = xlsx.utils.sheet_to_json(worksheet);
        
        const phoneWithoutSuffix = phoneNumber.replace('@c.us', '');
        const rowIndex = data.findIndex(row => row['Phone Number'] === phoneWithoutSuffix);
        
        if (rowIndex !== -1) {
            data[rowIndex]['Status'] = status;
            data[rowIndex]['Sent At'] = status === 'Sent' ? new Date().toISOString() : '';
            data[rowIndex]['Error'] = error;
            
            const newWorksheet = xlsx.utils.json_to_sheet(data);
            workbook.Sheets[workbook.SheetNames[0]] = newWorksheet;
            xlsx.writeFile(workbook, fileInfo.trackingPath);
            
            console.log(`Updated tracking file: ${phoneWithoutSuffix} -> ${status}`);
            return true;
        }
        
        return false;
    } catch (error) {
        console.error('Error updating tracking file:', error);
        return false;
    }
}

function getPendingPhoneNumbers(campaignId) {
    try {
        const fileInfo = campaignFiles.get(campaignId);
        if (!fileInfo || !fs.existsSync(fileInfo.trackingPath)) {
            console.log(`No tracking file found for campaign ${campaignId}`);
            return [];
        }
        
        const workbook = xlsx.readFile(fileInfo.trackingPath);
        const worksheet = workbook.Sheets[workbook.SheetNames[0]];
        const data = xlsx.utils.sheet_to_json(worksheet);
        
        const pendingNumbers = data
            .filter(row => row['Status'] === 'Pending')
            .map(row => row['Phone Number'] + '@c.us');
        
        const sentCount = data.filter(row => row['Status'] === 'Sent').length;
        const failedCount = data.filter(row => row['Status'] === 'Failed').length;
        console.log(`Campaign ${campaignId} tracking: ${pendingNumbers.length} pending, ${sentCount} sent, ${failedCount} failed`);
        
        return pendingNumbers;
    } catch (error) {
        console.error('Error reading tracking file:', error);
        return [];
    }
}

// Campaign management functions
async function continueCampaign(campaignId) {
    const campaignState = activeCampaigns.get(campaignId);
    if (!campaignState || campaignState.isPaused) {
        return;
    }
    
    const pendingPhoneNumbers = getPendingPhoneNumbers(campaignId);
    
    if (pendingPhoneNumbers.length === 0) {
        console.log(`No pending numbers found for campaign ${campaignId}`);
        return;
    }
    
    console.log(`Continuing campaign ${campaignId} with ${pendingPhoneNumbers.length} pending numbers`);
    
    await sendMessagesSequentially(
        pendingPhoneNumbers,
        campaignState.message,
        campaignState.mediaFile,
        campaignId,
        0,
        campaignState.delayRange || '1800-3600'
    );
}

async function sendMessagesSequentially(phoneNumbers, message, mediaFile, campaignId = null, startIndex = 0, delayRange = "1800-3600") {
    const results = [];
    let successCount = 0;
    let failureCount = 0;
    
    for (let i = 0; i < phoneNumbers.length; i++) {
        const phoneNumber = phoneNumbers[i];
        const currentIndex = startIndex + i;
        
        if (campaignId) {
            const campaignState = activeCampaigns.get(campaignId);
            if (!campaignState || campaignState.isPaused) {
                console.log(`Campaign ${campaignId} is paused, stopping at message ${currentIndex + 1}`);
                return;
            }
            
            campaignState.currentIndex = currentIndex;
        }
        
        try {
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

            console.log(`Checking if ${phoneNumber} is registered...`);
            io.emit('human_behavior', {
                number: phoneNumber,
                action: 'checking_registration',
                progress: currentIndex + 1,
                total: phoneNumbers.length + startIndex,
                campaignId: campaignId
            });

            const isRegistered = await client.isRegisteredUser(phoneNumber);
            
            if (isRegistered) {
                console.log(`Setting presence as available...`);
                try {
                    await client.sendPresenceAvailable();
                } catch (err) {
                    console.log('Could not set presence (non-critical):', err.message);
                }
                
                io.emit('human_behavior', {
                    number: phoneNumber,
                    action: 'online',
                    progress: currentIndex + 1,
                    total: phoneNumbers.length + startIndex,
                    campaignId: campaignId
                });

                const thinkingTime = getRandomDelay(2000, 8000);
                console.log(`Thinking for ${thinkingTime/1000}s before typing...`);
                
                io.emit('human_behavior', {
                    number: phoneNumber,
                    action: 'thinking',
                    duration: thinkingTime,
                    progress: currentIndex + 1,
                    total: phoneNumbers.length + startIndex,
                    campaignId: campaignId
                });
                
                await new Promise(resolve => setTimeout(resolve, thinkingTime));

                console.log(`Showing typing indicator for ${phoneNumber}...`);
                io.emit('human_behavior', {
                    number: phoneNumber,
                    action: 'typing',
                    progress: currentIndex + 1,
                    total: phoneNumbers.length + startIndex,
                    campaignId: campaignId
                });

                try {
                    const chat = await client.getChatById(phoneNumber);
                    await chat.sendStateTyping();
                    
                    const typingDuration = Math.max(3000, Math.min(30000, message.length * 100));
                    console.log(`Typing for ${typingDuration/1000}s (message length: ${message.length} chars)...`);
                    
                    await new Promise(resolve => setTimeout(resolve, typingDuration));
                    
                    console.log(`Sending message to ${phoneNumber}...`);
                    
                    if (mediaFile) {
                        console.log(`Sending media file: ${mediaFile.filename} to ${phoneNumber}`);
                        await client.sendMessage(phoneNumber, mediaFile, { caption: message });
                    } else {
                        await client.sendMessage(phoneNumber, message);
                    }
                    
                    results.push({ number: phoneNumber, status: 'sent', error: null });
                    successCount++;
                    
                    if (campaignId) {
                        const campaignState = activeCampaigns.get(campaignId);
                        if (campaignState) {
                            campaignState.sentCount++;
                        }
                        updateTrackingFile(campaignId, phoneNumber, 'Sent');
                    }
                    
                    io.emit('message_sent', { 
                        number: phoneNumber, 
                        status: 'sent', 
                        progress: currentIndex + 1, 
                        total: phoneNumbers.length + startIndex,
                        humanBehavior: true,
                        campaignId: campaignId
                    });

                    const postSendDelay = getRandomDelay(1000, 3000);
                    await new Promise(resolve => setTimeout(resolve, postSendDelay));

                } catch (chatError) {
                    console.error(`Error with chat operations for ${phoneNumber}:`, chatError);
                    if (mediaFile) {
                        console.log(`Sending media file (fallback): ${mediaFile.filename} to ${phoneNumber}`);
                        await client.sendMessage(phoneNumber, mediaFile, { caption: message });
                    } else {
                        await client.sendMessage(phoneNumber, message);
                    }
                    
                    results.push({ number: phoneNumber, status: 'sent', error: null });
                    successCount++;
                    
                    if (campaignId) {
                        const campaignState = activeCampaigns.get(campaignId);
                        if (campaignState) {
                            campaignState.sentCount++;
                        }
                        updateTrackingFile(campaignId, phoneNumber, 'Sent');
                    }
                    
                    io.emit('message_sent', { 
                        number: phoneNumber, 
                        status: 'sent', 
                        progress: currentIndex + 1, 
                        total: phoneNumbers.length + startIndex,
                        humanBehavior: true,
                        campaignId: campaignId
                    });
                }

            } else {
                results.push({ number: phoneNumber, status: 'not_registered', error: 'Number not registered on WhatsApp' });
                failureCount++;
                
                if (campaignId) {
                    const campaignState = activeCampaigns.get(campaignId);
                    if (campaignState) {
                        campaignState.failedCount++;
                    }
                    updateTrackingFile(campaignId, phoneNumber, 'Failed', 'Number not registered on WhatsApp');
                }
                
                io.emit('message_sent', { 
                    number: phoneNumber, 
                    status: 'not_registered', 
                    progress: currentIndex + 1, 
                    total: phoneNumbers.length + startIndex,
                    campaignId: campaignId
                });
            }
            
            if (i < phoneNumbers.length - 1) {
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
                
                try {
                    await client.sendPresenceUnavailable();
                } catch (err) {
                    console.log('Could not set presence unavailable (non-critical):', err.message);
                }
                
                await new Promise(resolve => setTimeout(resolve, humanDelay));
            }
            
        } catch (error) {
            console.error(`Error sending message to ${phoneNumber}:`, error);
            results.push({ number: phoneNumber, status: 'failed', error: error.message });
            failureCount++;
            
            if (campaignId) {
                const campaignState = activeCampaigns.get(campaignId);
                if (campaignState) {
                    campaignState.failedCount++;
                }
                updateTrackingFile(campaignId, phoneNumber, 'Failed', error.message);
            }
            
            io.emit('message_sent', { 
                number: phoneNumber, 
                status: 'failed', 
                error: error.message,
                progress: currentIndex + 1, 
                total: phoneNumbers.length + startIndex,
                campaignId: campaignId
            });
        }
    }
    
    if (campaignId) {
        const campaignState = activeCampaigns.get(campaignId);
        if (campaignState) {
            activeCampaigns.delete(campaignId);
            
            io.emit('bulk_send_complete', { 
                total: campaignState.phoneNumbers.length, 
                success: campaignState.sentCount, 
                failed: campaignState.failedCount,
                campaignId: campaignId
            });
            
            const fileInfo = campaignFiles.get(campaignId);
            if (fileInfo && fs.existsSync(fileInfo.trackingPath)) {
                console.log(`Campaign tracking file saved at: ${fileInfo.trackingPath}`);
            }
        }
    }
    
    return { successCount, failureCount, results };
}

// Helper function to validate and format phone numbers
function validateAndFormatPhoneNumber(phoneNumber, rowIndex) {
    if (rowIndex === 0 && /[a-zA-Z]/.test(phoneNumber) && !/^\d+$/.test(phoneNumber.replace(/[+\-\s]/g, ''))) {
        console.log('Skipping header row:', phoneNumber);
        return null;
    }
    
    const cleanNumber = phoneNumber.replace(/[+\-\s]/g, '');
    if (!/^\d+$/.test(cleanNumber)) {
        console.log('Skipping invalid phone number:', phoneNumber);
        return null;
    }
    
    if (cleanNumber.length < 10) {
        console.log('Skipping phone number too short:', phoneNumber);
        return null;
    }
    
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
    
    socket.emit('status', {
        authenticated: isClientAuthenticated,
        ready: isClientReady,
        message: getStatusMessage()
    });
    
    if (qrCodeData) {
        socket.emit('qr', qrCodeData);
    }
    
    socket.on('disconnect', () => {
        console.log('Client disconnected:', socket.id);
    });
});

// Serve the main HTML page
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    console.log('Initializing WhatsApp client...');
    
    // Initialize WhatsApp client
    initializeWhatsAppClient();
});

// Graceful shutdown
process.on('SIGINT', async () => {
    console.log('Shutting down gracefully...');
    
    if (client) {
        try {
            await client.destroy();
            console.log('WhatsApp client destroyed');
        } catch (error) {
            console.error('Error destroying WhatsApp client:', error);
        }
    }
    
    process.exit(0);
});
