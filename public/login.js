// Login page JavaScript
document.addEventListener('DOMContentLoaded', function() {
    const loginForm = document.getElementById('loginForm');
    const errorMessage = document.getElementById('errorMessage');
    const errorText = document.getElementById('errorText');
    const loginBtn = document.querySelector('.login-btn');

    // Check if user is already logged in
    if (localStorage.getItem('isLoggedIn') === 'true') {
        window.location.href = '/dashboard';
        return;
    }

    loginForm.addEventListener('submit', function(e) {
        e.preventDefault();
        
        const email = document.getElementById('email').value.trim();
        const password = document.getElementById('password').value;
        
        // Disable login button
        loginBtn.disabled = true;
        loginBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Logging in...';
        
        // Hide any previous error messages
        errorMessage.style.display = 'none';
        
        // Validate credentials
        if (email === 'glowmore.work@gmail.com' && password === 'Moti-420') {
            // Success - store login state
            localStorage.setItem('isLoggedIn', 'true');
            localStorage.setItem('loginTime', new Date().toISOString());
            
            // Show success message briefly
            loginBtn.innerHTML = '<i class="fas fa-check"></i> Success!';
            loginBtn.style.background = 'linear-gradient(135deg, #25D366 0%, #128C7E 100%)';
            
            // Redirect to dashboard after a short delay
            setTimeout(() => {
                window.location.href = '/dashboard';
            }, 1000);
            
        } else {
            // Show error message
            errorText.textContent = 'Invalid email or password. Please try again.';
            errorMessage.style.display = 'flex';
            
            // Reset button
            loginBtn.disabled = false;
            loginBtn.innerHTML = '<i class="fas fa-sign-in-alt"></i> Login';
            
            // Clear password field
            document.getElementById('password').value = '';
            document.getElementById('password').focus();
        }
    });

    // Handle Enter key in password field
    document.getElementById('password').addEventListener('keypress', function(e) {
        if (e.key === 'Enter') {
            loginForm.dispatchEvent(new Event('submit'));
        }
    });
});

// Toggle password visibility
function togglePassword() {
    const passwordInput = document.getElementById('password');
    const toggleBtn = document.querySelector('.toggle-password i');
    
    if (passwordInput.type === 'password') {
        passwordInput.type = 'text';
        toggleBtn.className = 'fas fa-eye-slash';
    } else {
        passwordInput.type = 'password';
        toggleBtn.className = 'fas fa-eye';
    }
}

// Auto-focus email field on page load
window.addEventListener('load', function() {
    document.getElementById('email').focus();
});
