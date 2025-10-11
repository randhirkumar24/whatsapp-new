// Initialize Socket.IO connection
const socket = io();

// DOM Elements
const statusIndicator = document.getElementById('statusIndicator');
const statusText = document.getElementById('statusText');
const statusMessage = document.getElementById('statusMessage');
const qrSection = document.getElementById('qrSection');
const qrCode = document.getElementById('qrCode');
const controlSection = document.getElementById('controlSection');
const progressSection = document.getElementById('progressSection');
const campaignSection = document.getElementById('campaignSection');
const logoutBtn = document.getElementById('logoutBtn');
const clearSessionBtn = document.getElementById('clearSessionBtn');
const forceReadyBtn = document.getElementById('forceReadyBtn');
const checkConnectionBtn = document.getElementById('checkConnectionBtn');
const showControlBtn = document.getElementById('showControlBtn');
const sendBtn = document.getElementById('sendBtn');
const phoneNumbers = document.getElementById('phoneNumbers');
const mediaFile = document.getElementById('mediaFile');
const messageText = document.getElementById('messageText');
const toastContainer = document.getElementById('toastContainer');
const numberCount = document.getElementById('numberCount');
const numberLimit = document.getElementById('numberLimit');
const limitInfo = document.getElementById('limitInfo');
const messageDelay = document.getElementById('messageDelay');

// Campaign Management Elements
const campaignList = document.getElementById('campaignList');
const activeCampaigns = document.getElementById('activeCampaigns');
const pendingCampaigns = document.getElementById('pendingCampaigns');
const completedCampaigns = document.getElementById('completedCampaigns');

// Message type elements (text messages only)
const excelUploadSection = document.getElementById('excelUploadSection');
const mediaUploadSection = document.getElementById('mediaUploadSection');

// Progress elements
const totalCount = document.getElementById('totalCount');
const successCount = document.getElementById('successCount');
const failureCount = document.getElementById('failureCount');
const progressFill = document.getElementById('progressFill');
const progressText = document.getElementById('progressText');
const logContent = document.getElementById('logContent');



// State variables
let isAuthenticated = false;
let isReady = false;
let isSending = false;

// Number limits based on delay selection
const numberLimits = {
    '30-60': { limit: 30, description: '30 numbers for 30-60 seconds delay' },
    '60-120': { limit: 50, description: '50 numbers for 60 seconds - 2 minutes delay' },
    '300-600': { limit: 100, description: '100 numbers for 5-10 minutes delay' },
    '600-1200': { limit: 200, description: '200 numbers for 10-20 minutes delay' },
    '1800-3600': { limit: 500, description: '500 numbers for 30-60 minutes delay' }
};

// Campaign Management
let campaignCounter = 0;
let campaigns = [];
let activeCampaign = null;
let campaignQueue = [];

// Initialize the application
document.addEventListener('DOMContentLoaded', function() {
    console.log('Application initialized');
    
    // Check authentication
    if (!checkAuthentication()) {
        return;
    }
    
    // Set up event listeners
    setupEventListeners();
    
    // Request initial status
    requestStatus();
    
    // Set up session timeout check (every 5 minutes)
    setInterval(checkSessionTimeout, 5 * 60 * 1000);
});

// Check if user is authenticated
function checkAuthentication() {
    const isLoggedIn = localStorage.getItem('isLoggedIn') === 'true';
    const loginTime = localStorage.getItem('loginTime');
    
    if (!isLoggedIn || !loginTime) {
        window.location.href = '/login';
        return false;
    }
    
    // Check if login is still valid (24 hours)
    const loginDate = new Date(loginTime);
    const now = new Date();
    const hoursDiff = (now - loginDate) / (1000 * 60 * 60);
    
    if (hoursDiff >= 24) {
        // Login expired
        localStorage.removeItem('isLoggedIn');
        localStorage.removeItem('loginTime');
        window.location.href = '/login';
        return false;
    }
    
    return true;
}

// Check session timeout
function checkSessionTimeout() {
    const loginTime = localStorage.getItem('loginTime');
    if (!loginTime) {
        window.location.href = '/login';
        return;
    }
    
    const loginDate = new Date(loginTime);
    const now = new Date();
    const hoursDiff = (now - loginDate) / (1000 * 60 * 60);
    
    if (hoursDiff >= 24) {
        // Session expired
        localStorage.removeItem('isLoggedIn');
        localStorage.removeItem('loginTime');
        alert('Your session has expired. Please login again.');
        window.location.href = '/login';
    }
}

// Set up all event listeners
function setupEventListeners() {
    // Socket.IO events
    socket.on('connect', () => {
        console.log('Connected to server');
        showToast('Connected to server', 'success');
    });

    socket.on('disconnect', () => {
        console.log('Disconnected from server');
        showToast('Disconnected from server', 'error');
    });

    socket.on('status', (data) => {
        console.log('Status update:', data);
        updateStatus(data);
    });

    socket.on('qr', (qrData) => {
        console.log('QR code received');
        displayQRCode(qrData);
    });

    socket.on('authenticated', () => {
        console.log('WhatsApp authenticated');
        isAuthenticated = true;
        showToast('WhatsApp authenticated successfully!', 'success');
        hideQRSection();
    });

    socket.on('ready', () => {
        console.log('WhatsApp client ready');
        isReady = true;
        showToast('WhatsApp is ready to send messages!', 'success');
        showControlPanel();
    });

    socket.on('auth_failure', (message) => {
        console.log('Authentication failed:', message);
        showToast('Authentication failed: ' + message, 'error');
    });

    socket.on('disconnected', (reason) => {
        console.log('WhatsApp disconnected:', reason);
        isAuthenticated = false;
        isReady = false;
        showToast('WhatsApp disconnected: ' + reason, 'error');
        hideControlPanel();
        hideProgressSection();
    });

    socket.on('logged_out', () => {
        console.log('Logged out successfully');
        isAuthenticated = false;
        isReady = false;
        showToast('Logged out successfully', 'success');
        hideControlPanel();
        hideProgressSection();
    });

    // Bulk sending events
    socket.on('bulk_send_start', (data) => {
        console.log('Bulk send started:', data);
        initializeProgress(data.total);
        showProgressSection();
    });

    socket.on('message_sent', (data) => {
        console.log('Message sent:', data);
        updateProgress(data);
        addLogEntry(data);
    });

    socket.on('bulk_send_complete', (data) => {
        console.log('Bulk send completed:', data);
        showToast(`Bulk send completed! ${data.success} sent, ${data.failed} failed`, 'success');
        isSending = false;
        updateSendButton();
        
        // Complete current campaign and start next one
        if (activeCampaign && data.campaignId === activeCampaign.id) {
            completeCampaign(activeCampaign.id, data);
            startNextCampaign();
        }
    });

    // Human behavior events
    socket.on('human_behavior', (data) => {
        console.log('Human behavior:', data);
        handleHumanBehavior(data);
        
        // Update active campaign with current action
        if (activeCampaign && data.campaignId === activeCampaign.id) {
            updateCampaignAction(activeCampaign.id, data);
        }
    });

    // DOM events
    logoutBtn.addEventListener('click', handleLogout);
    clearSessionBtn.addEventListener('click', handleClearSession);
    forceReadyBtn.addEventListener('click', handleForceReady);
    checkConnectionBtn.addEventListener('click', handleCheckConnection);
    showControlBtn.addEventListener('click', () => {
        console.log('Debug: Manual show control panel');
        showControlPanel();
        showControlBtn.style.display = 'none';
    });
    sendBtn.addEventListener('click', handleSendMessages);
    phoneNumbers.addEventListener('input', handlePhoneNumbersInput);
    mediaFile.addEventListener('change', handleFileSelect);
    messageDelay.addEventListener('change', handleDelayChange);
    messageText.addEventListener('input', handleMessageInput);
    
    // Add delay preview update
    messageDelay.addEventListener('change', updateDelayPreview);
    
    // Message type change events (removed - text messages only)
    
    // Initialize delay display
    updateDelayInfo();
    
    // Initialize delay preview
    updateDelayPreview();
    
    // Initialize character count
    handleMessageInput();
    
    // Debug: Force show control panel if WhatsApp is ready
    setTimeout(() => {
        console.log('Debug: Checking WhatsApp status...');
        console.log('isReady:', isReady);
        console.log('isAuthenticated:', isAuthenticated);
        console.log('controlSection display:', controlSection.style.display);
        
        // Force show control panel if it should be visible
        if (isReady || isAuthenticated) {
            console.log('Debug: Force showing control panel');
            showControlPanel();
        }
    }, 2000);
    

}

// Request current status from server
async function requestStatus() {
    try {
        const response = await fetch('/api/status');
        const data = await response.json();
        updateStatus(data);
        
        if (data.hasQR) {
            requestQRCode();
        }
    } catch (error) {
        console.error('Error fetching status:', error);
        showToast('Error fetching status', 'error');
    }
}

// Request QR code from server
async function requestQRCode() {
    try {
        const response = await fetch('/api/qr');
        const data = await response.json();
        if (data.qr) {
            displayQRCode(data.qr);
        }
    } catch (error) {
        console.error('Error fetching QR code:', error);
    }
}

// Update status display
function updateStatus(data) {
    isAuthenticated = data.authenticated;
    isReady = data.ready;
    
    // Update status indicator
    const statusDot = statusIndicator.querySelector('.status-dot');
    statusText.textContent = getStatusText(data);
    statusMessage.textContent = data.message;
    
    // Update status dot color
    statusDot.className = 'status-dot';
    if (isReady) {
        statusDot.classList.add('connected');
    } else if (data.authenticated) {
        statusDot.classList.add('connected');
    } else {
        // Default yellow for initializing/waiting
    }
    
    // Show/hide sections based on status
    if (isReady) {
        hideQRSection();
        showControlPanel();
        forceReadyBtn.style.display = 'none'; // Hide force ready when actually ready
    } else if (data.authenticated) {
        // Show control panel even if not fully ready (authenticated but loading)
        hideQRSection();
        showControlPanel();
        forceReadyBtn.style.display = 'inline-flex'; // Show force ready when authenticated but not ready
    } else if (data.hasQR && !isAuthenticated) {
        showQRSection();
        hideControlPanel();
        forceReadyBtn.style.display = 'none';
    } else {
        hideQRSection();
        hideControlPanel();
        forceReadyBtn.style.display = 'none';
    }
    
    hideProgressSection();
}

// Get status text based on current state
function getStatusText(data) {
    if (data.ready) {
        return 'Ready';
    } else if (data.authenticated) {
        return 'Authenticated';
    } else {
        return 'Not Connected';
    }
}

// Display QR code
function displayQRCode(qrData) {
    qrCode.innerHTML = `<img src="${qrData}" alt="WhatsApp QR Code">`;
    showQRSection();
}

// Show/hide sections
function showQRSection() {
    qrSection.style.display = 'block';
    qrSection.classList.add('fade-in');
}

function hideQRSection() {
    qrSection.style.display = 'none';
}

function showControlPanel() {
    controlSection.style.display = 'block';
    controlSection.classList.add('fade-in');
    updateSendButton();
    
    // Hide the show control button
    if (showControlBtn) {
        showControlBtn.style.display = 'none';
    }
    
    // Show campaign section if there are campaigns
    if (campaigns.length > 0) {
        showCampaignSection();
    }
}

function hideControlPanel() {
    controlSection.style.display = 'none';
}

function showProgressSection() {
    progressSection.style.display = 'block';
    progressSection.classList.add('fade-in');
}

function hideProgressSection() {
    progressSection.style.display = 'none';
}

// Handle check connection
async function handleCheckConnection() {
    showLoadingOverlay('Checking connection...');
    
    try {
        const response = await fetch('/api/check-connection', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            }
        });
        
        const data = await response.json();
        
        if (data.success) {
            showToast(`Connection healthy! State: ${data.state}`, 'success');
            console.log('Connection check result:', data);
        } else {
            showToast(`Connection issue: ${data.error}`, 'error');
            if (data.recommendation) {
                showToast(`Recommendation: ${data.recommendation}`, 'warning');
            }
        }
    } catch (error) {
        console.error('Check connection error:', error);
        showToast('Error checking connection: ' + error.message, 'error');
    } finally {
        hideLoadingOverlay();
    }
}

// Handle force ready
async function handleForceReady() {
    if (!confirm('Are you sure you want to force the WhatsApp client to ready state? This should only be used if the client is stuck at authenticated.')) {
        return;
    }
    
    showLoadingOverlay('Forcing ready state...');
    
    try {
        const response = await fetch('/api/force-ready', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            }
        });
        
        const data = await response.json();
        
        if (data.success) {
            showToast('Client forced to ready state successfully', 'success');
            // The page will automatically update via socket events
        } else {
            showToast('Failed to force ready state: ' + data.error, 'error');
        }
    } catch (error) {
        console.error('Force ready error:', error);
        showToast('Error forcing ready state: ' + error.message, 'error');
    } finally {
        hideLoadingOverlay();
    }
}

// Handle clear session
async function handleClearSession() {
    if (!confirm('Are you sure you want to clear the WhatsApp session? This will force a fresh login.')) {
        return;
    }
    
    showLoadingOverlay('Clearing session...');
    
    try {
        const response = await fetch('/api/clear-session', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            }
        });
        
        const data = await response.json();
        
        if (data.success) {
            showToast('Session cleared successfully', 'success');
            // The page will automatically update via socket events
        } else {
            showToast('Failed to clear session: ' + data.error, 'error');
        }
    } catch (error) {
        console.error('Clear session error:', error);
        showToast('Error clearing session: ' + error.message, 'error');
    } finally {
        hideLoadingOverlay();
    }
}

// Handle logout
async function handleLogout() {
    if (!confirm('Are you sure you want to logout from WhatsApp?')) {
        return;
    }
    
    showLoadingOverlay('Logging out...');
    
    try {
        const response = await fetch('/api/logout', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            }
        });
        
        const data = await response.json();
        
        if (data.success) {
            showToast('Logout successful', 'success');
            
            // Clear login state and redirect to login page
            localStorage.removeItem('isLoggedIn');
            localStorage.removeItem('loginTime');
            
            setTimeout(() => {
                window.location.href = '/login';
            }, 1500);
        } else {
            showToast('Logout failed: ' + data.error, 'error');
        }
    } catch (error) {
        console.error('Logout error:', error);
        showToast('Logout failed: ' + error.message, 'error');
    } finally {
        hideLoadingOverlay();
    }
}

// Handle message type change (removed - text messages only)
// Function kept for compatibility but not used

// Handle file selection
function handleFileSelect(event) {
    const file = event.target.files[0];
    const input = event.target;
    
    if (file) {
        // Find the corresponding label
        let label;
        if (input.id === 'excelFile') {
            label = input.parentElement.querySelector('.file-input-text');
        } else if (input.id === 'mediaFile') {
            label = input.parentElement.querySelector('.file-input-text');
        }
        
        if (label) {
            label.textContent = file.name;
        }
        updateSendButton();
    } else {
        // Reset label text based on input type
        let label;
        if (input.id === 'excelFile') {
            label = input.parentElement.querySelector('.file-input-text');
            if (label) label.textContent = 'Choose Excel File';
        } else if (input.id === 'mediaFile') {
            label = input.parentElement.querySelector('.file-input-text');
            if (label) label.textContent = 'SELECT MEDIA';
        }
        updateSendButton();
    }
}

// Handle phone numbers input
function handlePhoneNumbersInput() {
    const numbers = phoneNumbers.value.trim();
    const phoneNumbersList = numbers ? numbers.split('\n').filter(num => num.trim()) : [];
    const count = phoneNumbersList.length;
    const currentDelay = messageDelay.value;
    const limit = numberLimits[currentDelay].limit;
    
    // Update count display
    numberCount.textContent = count;
    numberLimit.textContent = `/ ${limit}`;
    
    // Update styling based on count
    phoneNumbers.classList.remove('warning', 'error');
    numberCount.classList.remove('warning', 'error');
    
    if (count > limit) {
        phoneNumbers.classList.add('error');
        numberCount.classList.add('error');
    } else if (count > limit * 0.8) {
        phoneNumbers.classList.add('warning');
        numberCount.classList.add('warning');
    }
    
    // Update send button state
    updateSendButton();
}

// Handle delay selection change
function handleDelayChange() {
    updateDelayInfo();
    handlePhoneNumbersInput(); // Re-validate current numbers
}

// Update delay information display
function updateDelayInfo() {
    const currentDelay = messageDelay.value;
    const limitInfo = numberLimits[currentDelay];
    
    document.getElementById('limitInfo').textContent = limitInfo.description;
    document.getElementById('numberLimit').textContent = `/ ${limitInfo.limit}`;
    
    // Re-validate current numbers
    handlePhoneNumbersInput();
}

// Handle message input
function handleMessageInput() {
    const message = messageText.value;
    const charCountElement = document.getElementById('charCount');
    
    if (charCountElement) {
        charCountElement.textContent = message.length;
    }
    
    // Update send button state
    updateSendButton();
}

// Update delay preview
function updateDelayPreview() {
    const currentDelay = messageDelay.value;
    const delayPreviewElement = document.getElementById('delayPreview');
    
    if (delayPreviewElement) {
        const [minDelay, maxDelay] = parseDelayRange(currentDelay);
        const minMinutes = Math.ceil(minDelay / 60);
        const maxMinutes = Math.ceil(maxDelay / 60);
        
        if (minMinutes === maxMinutes) {
            delayPreviewElement.textContent = `${minMinutes} minutes between messages`;
        } else {
            delayPreviewElement.textContent = `${minMinutes}-${maxMinutes} minutes between messages`;
        }
    }
}

// Update send button state
function updateSendButton() {
    // Text messages only (no media option)
    let hasFile = false;
    let hasRequiredData = false;
    let hasValidNumbers = false;
    
    // Check phone numbers
    const numbers = phoneNumbers.value.trim();
    const phoneNumbersList = numbers ? numbers.split('\n').filter(num => num.trim()) : [];
    const count = phoneNumbersList.length;
    const currentDelay = messageDelay.value;
    const limit = numberLimits[currentDelay].limit;
    hasValidNumbers = count > 0 && count <= limit;
    
    // For text messages, need phone numbers and message
    hasFile = hasValidNumbers;
    hasRequiredData = messageText.value.trim().length > 0;
    
    // Update recipient count and estimated time
    updateRecipientStats(count, currentDelay);
    
    // Allow sending when authenticated (not just when ready)
    const canSend = (isReady || isAuthenticated) && hasFile && hasRequiredData && !isSending;
    sendBtn.disabled = !canSend;
    
    if (isSending) {
        sendBtn.innerHTML = `
            <div class="send-btn-content">
                <div class="send-icon">
                    <i class="fas fa-spinner fa-spin"></i>
                </div>
                <div class="send-text">
                    <span class="send-label">Sending...</span>
                    <span class="send-subtitle">Please wait</span>
                </div>
            </div>
        `;
    } else if (!canSend) {
        let errorText = '';
        let errorSubtitle = '';
        
        if (!isReady && !isAuthenticated) {
            errorText = 'WhatsApp Not Connected';
            errorSubtitle = 'Connect WhatsApp first';
        } else if (!hasFile) {
            errorText = 'Enter Phone Numbers';
            errorSubtitle = 'Add recipients to continue';
        } else if (!hasRequiredData) {
            errorText = 'Enter Message';
            errorSubtitle = 'Write your message';
        } else {
            errorText = 'Send Messages';
            errorSubtitle = 'Start bulk messaging campaign';
        }
        
        sendBtn.innerHTML = `
            <div class="send-btn-content">
                <div class="send-icon">
                    <i class="fas fa-times-circle"></i>
                </div>
                <div class="send-text">
                    <span class="send-label">${errorText}</span>
                    <span class="send-subtitle">${errorSubtitle}</span>
                </div>
            </div>
        `;
    } else {
        sendBtn.innerHTML = `
            <div class="send-btn-content">
                <div class="send-icon">
                    <i class="fas fa-paper-plane"></i>
                </div>
                <div class="send-text">
                    <span class="send-label">Send Messages</span>
                    <span class="send-subtitle">Start bulk messaging campaign</span>
                </div>
            </div>
            <div class="send-arrow">
                <i class="fas fa-arrow-right"></i>
            </div>
        `;
    }
}

// Update recipient statistics
function updateRecipientStats(count, delayRange) {
    const recipientCountElement = document.getElementById('recipientCount');
    const estimatedTimeElement = document.getElementById('estimatedTime');
    
    if (recipientCountElement) {
        recipientCountElement.textContent = count;
    }
    
    if (estimatedTimeElement && count > 0) {
        const [minDelay, maxDelay] = parseDelayRange(delayRange);
        const avgDelay = (minDelay + maxDelay) / 2;
        const totalSeconds = count * avgDelay;
        const totalMinutes = Math.ceil(totalSeconds / 60);
        
        if (totalMinutes < 60) {
            estimatedTimeElement.textContent = `${totalMinutes} min`;
        } else {
            const hours = Math.floor(totalMinutes / 60);
            const minutes = totalMinutes % 60;
            if (minutes === 0) {
                estimatedTimeElement.textContent = `${hours}h`;
            } else {
                estimatedTimeElement.textContent = `${hours}h ${minutes}m`;
            }
        }
    } else if (estimatedTimeElement) {
        estimatedTimeElement.textContent = '0 min';
    }
}

// Parse delay range string (e.g., "1800-3600" -> [1800, 3600])
function parseDelayRange(delayRange) {
    const [min, max] = delayRange.split('-').map(Number);
    return [min, max];
}

// Handle send messages
async function handleSendMessages() {
    // Text messages only (no media option)
    await handleTextMessage();
}

// Handle text message sending
async function handleTextMessage() {
    const numbers = phoneNumbers.value.trim();
    const message = messageText.value.trim();
    
    if (!numbers) {
        showToast('Please enter phone numbers', 'error');
        return;
    }
    
    if (!message) {
        showToast('Please enter a message', 'error');
        return;
    }
    
    // Validate number count
    const phoneNumbersList = numbers.split('\n').filter(num => num.trim());
    const count = phoneNumbersList.length;
    const currentDelay = messageDelay.value;
    const limit = numberLimits[currentDelay].limit;
    
    if (count > limit) {
        showToast(`Too many numbers! Maximum ${limit} allowed for selected delay.`, 'error');
        return;
    }
    
    // Create new campaign
    const campaign = createCampaign('text', message, `${count} numbers`);
    addCampaignToQueue(campaign);
    
    const formData = new FormData();
    formData.append('phoneNumbers', numbers);
    formData.append('message', message);
    formData.append('fileType', 'text');
    formData.append('campaignId', campaign.id);
    formData.append('delayRange', document.getElementById('messageDelay').value);
    
    try {
        const response = await fetch('/api/upload-and-send', {
            method: 'POST',
            body: formData
        });
        
        const responseData = await response.json();
        
        if (!response.ok) {
            throw new Error(responseData.error || 'Upload failed');
        }
        
        showToast(`Campaign "${campaign.name}" added to queue!`, 'success');
        
    } catch (error) {
        console.error('Send error:', error);
        showToast('Error: ' + error.message, 'error');
        removeCampaignFromQueue(campaign.id);
    }
}

// Handle media message sending
async function handleMediaMessage() {
    const mediaFileData = mediaFile.files[0];
    const numbers = phoneNumbers.value.trim();
    const message = messageText.value.trim();
    
    if (!mediaFileData) {
        showToast('Please select a media file', 'error');
        return;
    }
    
    if (!numbers) {
        showToast('Please enter phone numbers', 'error');
        return;
    }
    
    // Validate number count
    const phoneNumbersList = numbers.split('\n').filter(num => num.trim());
    const count = phoneNumbersList.length;
    const currentDelay = messageDelay.value;
    const limit = numberLimits[currentDelay].limit;
    
    if (count > limit) {
        showToast(`Too many numbers! Maximum ${limit} allowed for selected delay.`, 'error');
        return;
    }
    
    // Create new campaign
    const campaign = createCampaign('media', message, `${count} numbers`, mediaFileData.name);
    addCampaignToQueue(campaign);
    
    const formData = new FormData();
    formData.append('mediaFile', mediaFileData);
    formData.append('phoneNumbers', numbers);
    formData.append('message', message);
    formData.append('fileType', 'media');
    formData.append('campaignId', campaign.id);
    formData.append('delayRange', document.getElementById('messageDelay').value);
    
    try {
        const response = await fetch('/api/upload-and-send', {
            method: 'POST',
            body: formData
        });
        
        const responseData = await response.json();
        
        if (!response.ok) {
            throw new Error(responseData.error || 'Upload failed');
        }
        
        showToast(`Campaign "${campaign.name}" added to queue!`, 'success');
        
    } catch (error) {
        console.error('Send error:', error);
        showToast('Error: ' + error.message, 'error');
        removeCampaignFromQueue(campaign.id);
    }
}

// Initialize progress tracking
function initializeProgress(total) {
    totalCount.textContent = total;
    successCount.textContent = '0';
    failureCount.textContent = '0';
    progressFill.style.width = '0%';
    progressText.textContent = '0%';
    logContent.innerHTML = '';
}

// Update progress
function updateProgress(data) {
    const total = parseInt(totalCount.textContent);
    const current = data.progress;
    const percentage = Math.round((current / total) * 100);
    
    // Update progress bar
    progressFill.style.width = percentage + '%';
    progressText.textContent = percentage + '%';
    
    // Update counters
    if (data.status === 'sent') {
        successCount.textContent = parseInt(successCount.textContent) + 1;
    } else {
        failureCount.textContent = parseInt(failureCount.textContent) + 1;
    }
}

// Add log entry
function addLogEntry(data) {
    const logEntry = document.createElement('div');
    logEntry.className = 'log-entry';
    
    // Determine entry class based on status
    if (data.status === 'sent') {
        logEntry.classList.add('success');
    } else if (data.status === 'not_registered') {
        logEntry.classList.add('warning');
    } else {
        logEntry.classList.add('error');
    }
    
    // Format phone number for display
    const phoneNumber = data.number.replace('@c.us', '');
    
    // Create status text
    let statusText = '';
    switch (data.status) {
        case 'sent':
            statusText = data.humanBehavior ? 'Sent successfully (with human behavior)' : 'Sent successfully';
            break;
        case 'not_registered':
            statusText = 'Not registered on WhatsApp';
            break;
        case 'failed':
            statusText = 'Failed: ' + (data.error || 'Unknown error');
            break;
        default:
            statusText = data.status;
    }
    
    logEntry.innerHTML = `
        <span class="log-number">${phoneNumber}</span>
        <span class="log-status">${statusText}</span>
    `;
    
    logContent.appendChild(logEntry);
    
    // Scroll to bottom
    logContent.scrollTop = logContent.scrollHeight;
}

// Handle human behavior updates
function handleHumanBehavior(data) {
    const phoneNumber = data.number.replace('@c.us', '');
    
    // Remove previous behavior entries for the same phone number
    const existingEntries = logContent.querySelectorAll('.behavior-entry');
    existingEntries.forEach(entry => {
        const entryPhoneNumber = entry.querySelector('.log-number').textContent.trim().split(' ').slice(1).join(' ');
        if (entryPhoneNumber === phoneNumber) {
            entry.remove();
        }
    });
    
    // Add human behavior log entry
    const behaviorEntry = document.createElement('div');
    behaviorEntry.className = 'log-entry behavior-entry';
    
    let behaviorText = '';
    let behaviorIcon = '';
    
    switch (data.action) {
        case 'waiting':
            behaviorText = `Waiting ${(data.duration / 1000).toFixed(1)}s before processing...`;
            behaviorIcon = '⏳';
            break;
        case 'checking_registration':
            behaviorText = 'Checking if number is registered...';
            behaviorIcon = '🔍';
            break;
        case 'online':
            behaviorText = 'Coming online...';
            behaviorIcon = '🟢';
            break;
        case 'thinking':
            behaviorText = `Thinking for ${(data.duration / 1000).toFixed(1)}s...`;
            behaviorIcon = '🤔';
            break;
        case 'typing':
            behaviorText = 'Typing message...';
            behaviorIcon = '⌨️';
            break;
        case 'human_delay':
            const nextNumber = data.nextNumber ? data.nextNumber.replace('@c.us', '') : 'next number';
            behaviorText = `Human delay: ${(data.duration / 1000).toFixed(1)}s before messaging ${nextNumber}`;
            behaviorIcon = '😴';
            break;
        default:
            behaviorText = data.action;
            behaviorIcon = '🤖';
    }
    
    behaviorEntry.innerHTML = `
        <span class="log-number">${behaviorIcon} ${phoneNumber}</span>
        <span class="log-status behavior-status">${behaviorText}</span>
    `;
    
    logContent.appendChild(behaviorEntry);
    
    // Scroll to bottom
    logContent.scrollTop = logContent.scrollHeight;
}



// Show toast notification
function showToast(message, type = 'info', duration = 5000) {
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    
    const icons = {
        success: 'fas fa-check-circle',
        error: 'fas fa-exclamation-circle',
        warning: 'fas fa-exclamation-triangle',
        info: 'fas fa-info-circle'
    };
    
    const titles = {
        success: 'Success',
        error: 'Error',
        warning: 'Warning',
        info: 'Info'
    };
    
    toast.innerHTML = `
        <div class="toast-header">
            <div class="toast-title">
                <i class="${icons[type]}"></i> ${titles[type]}
            </div>
            <button class="toast-close">&times;</button>
        </div>
        <div class="toast-message">${message}</div>
    `;
    
    // Add close functionality
    const closeBtn = toast.querySelector('.toast-close');
    closeBtn.addEventListener('click', () => {
        removeToast(toast);
    });
    
    // Add to container
    toastContainer.appendChild(toast);
    
    // Auto remove after duration
    setTimeout(() => {
        removeToast(toast);
    }, duration);
}

// Remove toast
function removeToast(toast) {
    if (toast && toast.parentNode) {
        toast.style.animation = 'slideOut 0.3s ease';
        setTimeout(() => {
            if (toast.parentNode) {
                toast.parentNode.removeChild(toast);
            }
        }, 300);
    }
}

// Show loading overlay
function showLoadingOverlay(message = 'Loading...') {
    let overlay = document.getElementById('loadingOverlay');
    if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'loadingOverlay';
        overlay.style.cssText = `
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background: rgba(0, 0, 0, 0.7);
            display: flex;
            justify-content: center;
            align-items: center;
            z-index: 10000;
            color: white;
            font-size: 1.2rem;
        `;
        document.body.appendChild(overlay);
    }
    overlay.innerHTML = `
        <div style="text-align: center;">
            <i class="fas fa-spinner fa-spin" style="font-size: 2rem; margin-bottom: 10px;"></i>
            <div>${message}</div>
        </div>
    `;
    overlay.style.display = 'flex';
}

// Hide loading overlay
function hideLoadingOverlay() {
    const overlay = document.getElementById('loadingOverlay');
    if (overlay) {
        overlay.style.display = 'none';
    }
}

// Add slideOut animation to CSS if not present
const style = document.createElement('style');
style.textContent = `
    @keyframes slideOut {
        from {
            transform: translateX(0);
            opacity: 1;
        }
        to {
            transform: translateX(100%);
            opacity: 0;
        }
    }
`;
document.head.appendChild(style);

// Listen for input changes
messageText.addEventListener('input', updateSendButton);

// Handle page visibility change
document.addEventListener('visibilitychange', function() {
    if (!document.hidden) {
        // Page became visible, request status update
        requestStatus();
    }
});

console.log('WhatsApp Bulk Sender initialized successfully');

// Campaign Management Functions
function createCampaign(type, message, excelFileName) {
    campaignCounter++;
    const campaign = {
        id: `campaign_${campaignCounter}`,
        name: `Campaign ${campaignCounter}`,
        type: type,
        message: message,
        excelFileName: excelFileName,
        status: 'pending',
        total: 0,
        sent: 0,
        failed: 0,
        progress: 0,
        currentAction: 'Waiting in queue...',
        createdAt: new Date(),
        startedAt: null,
        completedAt: null
    };
    
    campaigns.push(campaign);
    return campaign;
}

function addCampaignToQueue(campaign) {
    campaignQueue.push(campaign);
    updateCampaignDisplay();
    
    // If no active campaign, start this one
    if (!activeCampaign) {
        startNextCampaign();
    }
}

function removeCampaignFromQueue(campaignId) {
    const index = campaignQueue.findIndex(c => c.id === campaignId);
    if (index > -1) {
        campaignQueue.splice(index, 1);
    }
    
    const campaignIndex = campaigns.findIndex(c => c.id === campaignId);
    if (campaignIndex > -1) {
        campaigns.splice(campaignIndex, 1);
    }
    
    updateCampaignDisplay();
}

function startNextCampaign() {
    if (campaignQueue.length === 0 || activeCampaign) {
        return;
    }
    
    const nextCampaign = campaignQueue.shift();
    activeCampaign = nextCampaign;
    nextCampaign.status = 'active';
    nextCampaign.startedAt = new Date();
    
    updateCampaignDisplay();
    showCampaignSection();
}

// Update campaign status when it's paused
function updateCampaignToPaused(campaignId) {
    const campaign = campaigns.find(c => c.id === campaignId);
    if (campaign) {
        campaign.status = 'paused';
        campaign.currentAction = 'Paused';
        
        // If this was the active campaign, clear it and start the next one
        if (activeCampaign && activeCampaign.id === campaignId) {
            activeCampaign = null;
            startNextCampaign();
        }
        
        updateCampaignDisplay();
    }
}

// Update campaign status when it's resumed
function updateCampaignToActive(campaignId) {
    const campaign = campaigns.find(c => c.id === campaignId);
    if (campaign) {
        campaign.status = 'active';
        campaign.currentAction = 'Resuming...';
        
        // If there's no active campaign, make this one active
        if (!activeCampaign) {
            activeCampaign = campaign;
        }
        
        updateCampaignDisplay();
    }
}

function completeCampaign(campaignId, result) {
    const campaign = campaigns.find(c => c.id === campaignId);
    if (campaign) {
        campaign.status = 'completed';
        campaign.completedAt = new Date();
        campaign.sent = result.success || 0;
        campaign.failed = result.failed || 0;
        campaign.progress = 100;
        campaign.currentAction = 'Completed';
    }
    
    activeCampaign = null;
    updateCampaignDisplay();
}

function updateCampaignProgress(campaignId, progress) {
    const campaign = campaigns.find(c => c.id === campaignId);
    if (campaign) {
        campaign.progress = progress;
        updateCampaignDisplay();
    }
}

function updateCampaignAction(campaignId, actionData) {
    const campaign = campaigns.find(c => c.id === campaignId);
    if (campaign) {
        let actionText = '';
        const phoneNumber = actionData.number ? actionData.number.replace('@c.us', '') : '';
        
        switch (actionData.action) {
            case 'waiting':
                actionText = `Waiting ${(actionData.duration / 1000).toFixed(1)}s before processing...`;
                break;
            case 'checking_registration':
                actionText = `Checking if ${phoneNumber} is registered...`;
                break;
            case 'online':
                actionText = 'Coming online...';
                break;
            case 'thinking':
                actionText = `Thinking for ${(actionData.duration / 1000).toFixed(1)}s...`;
                break;
            case 'typing':
                actionText = `Typing message to ${phoneNumber}...`;
                break;
            case 'human_delay':
                const nextNumber = actionData.nextNumber ? actionData.nextNumber.replace('@c.us', '') : 'next number';
                actionText = `Human delay: ${(actionData.duration / 1000).toFixed(1)}s before messaging ${nextNumber}`;
                break;
            default:
                actionText = actionData.action;
        }
        
        campaign.currentAction = actionText;
        updateCampaignDisplay();
    }
}

function updateCampaignDisplay() {
    // Update campaign stats
    const activeCount = campaigns.filter(c => c.status === 'active').length;
    const pendingCount = campaigns.filter(c => c.status === 'pending').length;
    const pausedCount = campaigns.filter(c => c.status === 'paused').length;
    const completedCount = campaigns.filter(c => c.status === 'completed').length;
    
    activeCampaigns.textContent = activeCount;
    pendingCampaigns.textContent = pendingCount + pausedCount; // Show paused campaigns in pending count
    completedCampaigns.textContent = completedCount;
    
    // Update campaign list
    campaignList.innerHTML = '';
    
    campaigns.forEach(campaign => {
        const campaignElement = createCampaignElement(campaign);
        campaignList.appendChild(campaignElement);
    });
    
    // Show/hide campaign section
    if (campaigns.length > 0) {
        showCampaignSection();
    } else {
        hideCampaignSection();
    }
}

function createCampaignElement(campaign) {
    const campaignDiv = document.createElement('div');
    campaignDiv.className = `campaign-item ${campaign.status}`;
    campaignDiv.id = `campaign-${campaign.id}`;
    
    const statusIcon = getStatusIcon(campaign.status);
    const statusClass = campaign.status;
    
    campaignDiv.innerHTML = `
        <div class="campaign-item-header">
            <div class="campaign-title">
                <i class="${statusIcon}"></i>
                ${campaign.name}
            </div>
            <span class="campaign-status ${statusClass}">${campaign.status}</span>
        </div>
        
        <div class="campaign-details">
            <div class="campaign-detail">
                <span class="campaign-detail-label">Type</span>
                <span class="campaign-detail-value">${campaign.type === 'text' ? 'Text' : 'Media'}</span>
            </div>
            <div class="campaign-detail">
                <span class="campaign-detail-label">Total</span>
                <span class="campaign-detail-value">${campaign.total}</span>
            </div>
            <div class="campaign-detail">
                <span class="campaign-detail-label">Sent</span>
                <span class="campaign-detail-value">${campaign.sent}</span>
            </div>
            <div class="campaign-detail">
                <span class="campaign-detail-label">Failed</span>
                <span class="campaign-detail-value">${campaign.failed}</span>
            </div>
        </div>
        
        <div class="campaign-progress">
            <div class="campaign-progress-bar">
                <div class="campaign-progress-fill" style="width: ${campaign.progress}%"></div>
            </div>
            <div class="campaign-progress-text">${campaign.progress}% Complete</div>
        </div>
        
        ${campaign.status === 'active' ? `
            <div class="campaign-current-action">
                <i class="fas fa-info-circle"></i> ${campaign.currentAction}
            </div>
        ` : ''}
        
                 <div class="campaign-actions">
             ${campaign.status === 'pending' ? `
                 <button class="campaign-action-btn cancel" onclick="cancelCampaign('${campaign.id}')">
                     <i class="fas fa-times"></i> Cancel
                 </button>
             ` : ''}
             ${campaign.status === 'active' ? `
                 <button class="campaign-action-btn pause" onclick="pauseCampaign('${campaign.id}')">
                     <i class="fas fa-pause"></i> Pause
                 </button>
             ` : ''}
             ${campaign.status === 'paused' ? `
                 <button class="campaign-action-btn resume" onclick="resumeCampaign('${campaign.id}')">
                     <i class="fas fa-play"></i> Resume
                 </button>
             ` : ''}
         </div>
    `;
    
    return campaignDiv;
}

function getStatusIcon(status) {
    switch (status) {
        case 'active':
            return 'fas fa-play-circle';
        case 'pending':
            return 'fas fa-clock';
        case 'paused':
            return 'fas fa-pause-circle';
        case 'completed':
            return 'fas fa-check-circle';
        default:
            return 'fas fa-circle';
    }
}

function showCampaignSection() {
    campaignSection.style.display = 'block';
    campaignSection.classList.add('fade-in');
}

function hideCampaignSection() {
    campaignSection.style.display = 'none';
}

function cancelCampaign(campaignId) {
    const campaign = campaigns.find(c => c.id === campaignId);
    if (campaign && campaign.status === 'pending') {
        removeCampaignFromQueue(campaignId);
        showToast(`Campaign "${campaign.name}" cancelled`, 'success');
    }
}

async function pauseCampaign(campaignId) {
    try {
        const response = await fetch('/api/campaign/pause', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ campaignId: campaignId })
        });
        
        const data = await response.json();
        
        if (data.success) {
            updateCampaignToPaused(campaignId);
            showToast(`Campaign paused successfully`, 'success');
        } else {
            showToast('Failed to pause campaign: ' + data.error, 'error');
        }
    } catch (error) {
        console.error('Error pausing campaign:', error);
        showToast('Error pausing campaign: ' + error.message, 'error');
    }
}

async function resumeCampaign(campaignId) {
    try {
        const response = await fetch('/api/campaign/resume', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ campaignId: campaignId })
        });
        
        const data = await response.json();
        
        if (data.success) {
            updateCampaignToActive(campaignId);
            showToast(`Campaign resumed successfully`, 'success');
        } else {
            showToast('Failed to resume campaign: ' + data.error, 'error');
        }
    } catch (error) {
        console.error('Error resuming campaign:', error);
        showToast('Error resuming campaign: ' + error.message, 'error');
    }
}

// Update socket events to handle campaign progress
    socket.on('bulk_send_start', (data) => {
        console.log('Bulk send started:', data);
        if (activeCampaign && data.campaignId === activeCampaign.id) {
            activeCampaign.total = data.total;
            activeCampaign.progress = 0;
            activeCampaign.status = 'active'; // Ensure status is set to active
            updateCampaignDisplay();
            console.log('Campaign status set to active:', activeCampaign.id);
        }
    });

    socket.on('message_sent', (data) => {
        console.log('Message sent:', data);
        if (activeCampaign && data.campaignId === activeCampaign.id) {
            if (data.status === 'sent') {
                activeCampaign.sent++;
            } else {
                activeCampaign.failed++;
            }
            
            const total = activeCampaign.total;
            const current = activeCampaign.sent + activeCampaign.failed;
            const progress = Math.round((current / total) * 100);
            
            activeCampaign.progress = progress;
            updateCampaignDisplay();
        }
    });


