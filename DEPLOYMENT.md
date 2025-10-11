# WhatsApp Bot Deployment Guide

## Railway Deployment

This bot is configured for seamless deployment on Railway.app with Docker.

### Files Created for Deployment:

1. **Dockerfile** - Container configuration with Puppeteer support
2. **railway.json** - Railway-specific deployment configuration
3. **.dockerignore** - Excludes unnecessary files from Docker build
4. **Health Check Endpoint** - `/health` endpoint for monitoring

### Deployment Steps:

1. **Push to GitHub** (if not already done)
2. **Connect to Railway**:
   - Go to [Railway.app](https://railway.app)
   - Create new project
   - Connect your GitHub repository
3. **Deploy**: Railway will automatically detect the Dockerfile and deploy

### Environment Variables:

The bot uses these environment variables:
- `NODE_ENV=production` (set automatically)
- `PORT=3000` (Railway will set this automatically)

### Health Check:

The bot exposes a health check endpoint at `/health` that returns:
```json
{
  "status": "healthy",
  "timestamp": "2024-01-01T00:00:00.000Z",
  "clientReady": true
}
```

### Important Notes:

- **QR Code**: You'll need to scan the QR code from the Railway logs to authenticate
- **Session Persistence**: The bot will maintain session data in the container
- **Restart Policy**: Configured to restart on failure
- **Puppeteer**: Uses Chromium in the container for WhatsApp Web automation

### Local Testing:

To test the Docker setup locally:
```bash
docker build -t whatsapp-bot .
docker run -p 3000:3000 whatsapp-bot
```

### Monitoring:

- Check Railway dashboard for logs
- Use `/health` endpoint for health monitoring
- Monitor QR code generation in logs for authentication status
