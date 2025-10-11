// Account Manager JavaScript
let accounts = [];
let stats = {
    total: 0,
    connected: 0,
    pending: 0,
    campaigns: 0
};

// Initialize the application
document.addEventListener('DOMContentLoaded', function() {
    console.log('Account Manager initialized');
    
    // Check authentication
    if (!checkAuthentication()) {
        return;
    }
    
    // Load accounts and stats
    loadAccounts();
    setupEventListeners();
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

// Set up event listeners
function setupEventListeners() {
    // Add account form
    document.getElementById('addAccountForm').addEventListener('submit', handleAddAccount);
    
    // Color picker options
    document.querySelectorAll('.color-option').forEach(option => {
        option.addEventListener('click', function() {
            const color = this.dataset.color;
            document.getElementById('accountColor').value = color;
            
            // Update selected state
            document.querySelectorAll('.color-option').forEach(opt => opt.classList.remove('selected'));
            this.classList.add('selected');
        });
    });
    
    // Color input change
    document.getElementById('accountColor').addEventListener('change', function() {
        document.querySelectorAll('.color-option').forEach(opt => opt.classList.remove('selected'));
    });
    
    // Modal click outside to close
    document.querySelectorAll('.modal').forEach(modal => {
        modal.addEventListener('click', function(e) {
            if (e.target === this) {
                hideAllModals();
            }
        });
    });
}

// Load accounts from server
async function loadAccounts() {
    try {
        const response = await fetch('/api/accounts');
        const data = await response.json();
        
        if (data.success) {
            accounts = data.accounts || [];
            updateAccountsDisplay();
            updateStats();
        } else {
            showToast('Failed to load accounts: ' + data.error, 'error');
        }
    } catch (error) {
        console.error('Error loading accounts:', error);
        showToast('Error loading accounts', 'error');
        
        // Load from localStorage as fallback
        const savedAccounts = localStorage.getItem('whatsapp_accounts');
        if (savedAccounts) {
            accounts = JSON.parse(savedAccounts);
            updateAccountsDisplay();
            updateStats();
        }
    }
}

// Update accounts display
function updateAccountsDisplay() {
    const accountsGrid = document.getElementById('accountsGrid');
    const noAccounts = document.getElementById('noAccounts');
    
    if (accounts.length === 0) {
        noAccounts.style.display = 'block';
        // Clear any existing account cards
        const existingCards = accountsGrid.querySelectorAll('.account-card');
        existingCards.forEach(card => card.remove());
        return;
    }
    
    noAccounts.style.display = 'none';
    
    // Clear existing cards
    const existingCards = accountsGrid.querySelectorAll('.account-card');
    existingCards.forEach(card => card.remove());
    
    // Create account cards
    accounts.forEach(account => {
        const accountCard = createAccountCard(account);
        accountsGrid.appendChild(accountCard);
    });
}

// Create account card element
function createAccountCard(account) {
    const card = document.createElement('div');
    card.className = 'account-card';
    card.style.borderLeftColor = account.color;
    
    const statusClass = getStatusClass(account.status);
    const statusText = getStatusText(account.status);
    
    card.innerHTML = `
        <div class="account-header">
            <div class="account-info">
                <h3>${account.name}</h3>
                <p>${account.description || 'No description'}</p>
            </div>
            <div class="account-status">
                <span class="status-dot ${statusClass}"></span>
                <span>${statusText}</span>
            </div>
        </div>
        <div class="account-actions">
            ${account.status === 'disconnected' ? 
                `<button class="action-btn connect-btn" onclick="connectAccount('${account.id}')">
                    <i class="fas fa-plug"></i>
                    Connect
                </button>` :
                `<button class="action-btn use-btn" onclick="useAccount('${account.id}')">
                    <i class="fas fa-paper-plane"></i>
                    Use Account
                </button>`
            }
            <button class="action-btn delete-btn" onclick="deleteAccount('${account.id}')">
                <i class="fas fa-trash"></i>
                Delete
            </button>
        </div>
    `;
    
    return card;
}

// Get status class for styling
function getStatusClass(status) {
    switch (status) {
        case 'connected':
        case 'ready':
            return 'connected';
        case 'disconnected':
            return 'disconnected';
        default:
            return 'pending';
    }
}

// Get status text
function getStatusText(status) {
    switch (status) {
        case 'connected':
            return 'Connected';
        case 'ready':
            return 'Ready';
        case 'disconnected':
            return 'Disconnected';
        case 'connecting':
            return 'Connecting...';
        case 'qr_pending':
            return 'QR Pending';
        default:
            return 'Unknown';
    }
}

// Update statistics
function updateStats() {
    stats.total = accounts.length;
    stats.connected = accounts.filter(acc => acc.status === 'connected' || acc.status === 'ready').length;
    stats.pending = accounts.filter(acc => acc.status === 'connecting' || acc.status === 'qr_pending').length;
    
    // Update DOM
    document.getElementById('totalAccounts').textContent = stats.total;
    document.getElementById('connectedAccounts').textContent = stats.connected;
    document.getElementById('pendingAccounts').textContent = stats.pending;
    document.getElementById('totalCampaigns').textContent = stats.campaigns;
}

// Handle add account form submission
async function handleAddAccount(e) {
    e.preventDefault();
    
    const formData = new FormData(e.target);
    const accountData = {
        name: formData.get('accountName'),
        description: formData.get('accountDescription'),
        color: formData.get('accountColor')
    };
    
    try {
        const response = await fetch('/api/accounts', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(accountData)
        });
        
        const data = await response.json();
        
        if (data.success) {
            showToast('Account created successfully!', 'success');
            hideAddAccountModal();
            
            // Add to local accounts array
            accounts.push(data.account);
            updateAccountsDisplay();
            updateStats();
            
            // Save to localStorage as backup
            localStorage.setItem('whatsapp_accounts', JSON.stringify(accounts));
            
            // Reset form
            e.target.reset();
        } else {
            showToast('Failed to create account: ' + data.error, 'error');
        }
    } catch (error) {
        console.error('Error creating account:', error);
        showToast('Error creating account', 'error');
    }
}

// Connect to WhatsApp account
async function connectAccount(accountId) {
    try {
        showToast('Connecting to WhatsApp...', 'info');
        
        const response = await fetch(`/api/accounts/${accountId}/connect`, {
            method: 'POST'
        });
        
        const data = await response.json();
        
        if (data.success) {
            showToast('Connection initiated! Check QR code.', 'success');
            
            // Update account status
            const account = accounts.find(acc => acc.id === accountId);
            if (account) {
                account.status = 'connecting';
                updateAccountsDisplay();
                updateStats();
            }
        } else {
            showToast('Failed to connect: ' + data.error, 'error');
        }
    } catch (error) {
        console.error('Error connecting account:', error);
        showToast('Error connecting account', 'error');
    }
}

// Use WhatsApp account (go to dashboard)
function useAccount(accountId) {
    // Store selected account ID
    localStorage.setItem('selectedAccount', accountId);
    
    // Redirect to dashboard
    window.location.href = '/dashboard';
}

// Delete WhatsApp account
async function deleteAccount(accountId) {
    if (!confirm('Are you sure you want to delete this account? This action cannot be undone.')) {
        return;
    }
    
    try {
        const response = await fetch(`/api/accounts/${accountId}`, {
            method: 'DELETE'
        });
        
        const data = await response.json();
        
        if (data.success) {
            showToast('Account deleted successfully!', 'success');
            
            // Remove from local accounts array
            accounts = accounts.filter(acc => acc.id !== accountId);
            updateAccountsDisplay();
            updateStats();
            
            // Update localStorage
            localStorage.setItem('whatsapp_accounts', JSON.stringify(accounts));
        } else {
            showToast('Failed to delete account: ' + data.error, 'error');
        }
    } catch (error) {
        console.error('Error deleting account:', error);
        showToast('Error deleting account', 'error');
    }
}

// Modal functions
function showAddAccountModal() {
    const modal = document.getElementById('addAccountModal');
    modal.classList.add('show');
    
    // Focus on account name input
    setTimeout(() => {
        document.getElementById('accountName').focus();
    }, 100);
}

function hideAddAccountModal() {
    const modal = document.getElementById('addAccountModal');
    modal.classList.remove('show');
    
    // Reset form
    document.getElementById('addAccountForm').reset();
    document.querySelectorAll('.color-option').forEach(opt => opt.classList.remove('selected'));
}

function showAccountDetailsModal(accountId) {
    const modal = document.getElementById('accountDetailsModal');
    const account = accounts.find(acc => acc.id === accountId);
    
    if (!account) return;
    
    // Update modal content
    document.getElementById('accountDetailsTitle').innerHTML = `
        <i class="fas fa-user"></i> ${account.name}
    `;
    
    document.getElementById('accountDetailsContent').innerHTML = `
        <div class="account-details">
            <div class="detail-item">
                <strong>Name:</strong> ${account.name}
            </div>
            <div class="detail-item">
                <strong>Description:</strong> ${account.description || 'No description'}
            </div>
            <div class="detail-item">
                <strong>Status:</strong> ${getStatusText(account.status)}
            </div>
            <div class="detail-item">
                <strong>Color:</strong> 
                <span class="color-preview" style="background: ${account.color}; width: 20px; height: 20px; display: inline-block; border-radius: 50%; margin-left: 10px;"></span>
            </div>
            <div class="detail-item">
                <strong>Created:</strong> ${account.createdAt ? new Date(account.createdAt).toLocaleString() : 'Unknown'}
            </div>
        </div>
    `;
    
    modal.classList.add('show');
}

function hideAccountDetailsModal() {
    const modal = document.getElementById('accountDetailsModal');
    modal.classList.remove('show');
}

function hideAllModals() {
    document.querySelectorAll('.modal').forEach(modal => {
        modal.classList.remove('show');
    });
}

// Navigation functions
function goToDashboard() {
    window.location.href = '/dashboard';
}

function logout() {
    if (!confirm('Are you sure you want to logout?')) {
        return;
    }
    
    // Clear login state
    localStorage.removeItem('isLoggedIn');
    localStorage.removeItem('loginTime');
    localStorage.removeItem('selectedAccount');
    
    // Redirect to login
    window.location.href = '/login';
}

// Toast notification function
function showToast(message, type = 'info') {
    const toastContainer = document.getElementById('toastContainer');
    
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    
    const icon = type === 'success' ? 'check-circle' : 
                 type === 'error' ? 'exclamation-triangle' : 
                 'info-circle';
    
    toast.innerHTML = `
        <i class="fas fa-${icon}"></i>
        <span>${message}</span>
    `;
    
    toastContainer.appendChild(toast);
    
    // Remove toast after 5 seconds
    setTimeout(() => {
        toast.remove();
    }, 5000);
}

// Keyboard shortcuts
document.addEventListener('keydown', function(e) {
    // Escape key to close modals
    if (e.key === 'Escape') {
        hideAllModals();
    }
    
    // Ctrl+N to add new account
    if (e.ctrlKey && e.key === 'n') {
        e.preventDefault();
        showAddAccountModal();
    }
});

// Auto-refresh account status every 30 seconds
setInterval(async function() {
    if (accounts.length > 0) {
        try {
            const response = await fetch('/api/accounts/status');
            const data = await response.json();
            
            if (data.success && data.accounts) {
                // Update account statuses
                data.accounts.forEach(serverAccount => {
                    const localAccount = accounts.find(acc => acc.id === serverAccount.id);
                    if (localAccount && localAccount.status !== serverAccount.status) {
                        localAccount.status = serverAccount.status;
                    }
                });
                
                updateAccountsDisplay();
                updateStats();
            }
        } catch (error) {
            console.log('Status refresh failed:', error);
        }
    }
}, 30000);
