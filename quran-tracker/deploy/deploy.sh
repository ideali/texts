#!/bin/bash
# Deploy Quran Tracker to VPS (31.40.29.176 / aniner.xyz)
# Run this script from the quran-tracker directory

set -e

SERVER="root@31.40.29.176"
REMOTE_DIR="/var/www/quran-tracker"

echo "=== Deploying Quran Tracker to aniner.xyz/quran ==="

# 1. Create remote directory
ssh $SERVER "mkdir -p $REMOTE_DIR"

# 2. Upload web files
echo "Uploading files..."
rsync -avz --delete \
    web/index-mobile.html \
    web/app-standalone.js \
    web/style.css \
    $SERVER:$REMOTE_DIR/

# Upload data directory
rsync -avz --delete web/data/ $SERVER:$REMOTE_DIR/data/

# 3. Rename index for clean URL
ssh $SERVER "cp $REMOTE_DIR/index-mobile.html $REMOTE_DIR/index.html"

# 4. Set permissions
ssh $SERVER "chown -R www-data:www-data $REMOTE_DIR && chmod -R 755 $REMOTE_DIR"

echo ""
echo "=== Files uploaded ==="
echo ""
echo "Next steps on the server:"
echo "1. Install certbot if not done:"
echo "   apt install certbot python3-certbot-nginx"
echo ""
echo "2. Copy nginx config:"
echo "   scp deploy/nginx.conf $SERVER:/etc/nginx/sites-available/aniner.xyz"
echo "   ssh $SERVER 'ln -sf /etc/nginx/sites-available/aniner.xyz /etc/nginx/sites-enabled/'"
echo ""
echo "3. Get SSL certificate:"
echo "   ssh $SERVER 'certbot --nginx -d aniner.xyz'"
echo ""
echo "4. Reload nginx:"
echo "   ssh $SERVER 'nginx -t && systemctl reload nginx'"
echo ""
echo "5. Open https://aniner.xyz/quran/ in your browser"
