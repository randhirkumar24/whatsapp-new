// Local development script for Windows
process.env.NODE_ENV = 'development';
process.env.PUPPETEER_EXECUTABLE_PATH = undefined; // Let Puppeteer use bundled Chrome

console.log('Starting WhatsApp Bulk Sender in development mode...');
console.log('Environment: Windows Local Development');
console.log('Puppeteer: Using bundled Chrome');

require('./server.js');
