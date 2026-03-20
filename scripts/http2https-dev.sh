#!/usr/bin/env bash

# Local development HTTPS setup script
# Used to configure a local HTTPS development server so devices like phones can access sensitive APIs such as the camera

set -e

# Detect the machine's LAN IP address
get_local_ip() {
    if [[ "$OSTYPE" == "darwin"* ]]; then
        ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || echo "127.0.0.1"
    else
        hostname -I | awk '{print $1}'
    fi
}

LOCAL_IP=$(get_local_ip)
CERT_DIR="certs"
PORT=3000

echo "=========================================="
echo "  Local HTTPS development setup"
echo "=========================================="
echo ""
echo "Local IP: $LOCAL_IP"
echo ""

# Step 1: install mkcert
echo "[1/7] Installing mkcert..."
npm install --save-dev mkcert

# Step 2: create the CA certificate
echo "[2/7] Creating local CA certificate..."
npx mkcert create-ca --validity 365

# Step 3: create the SSL certificate
echo "[3/7] Creating SSL certificate (localhost, $LOCAL_IP)..."
npx mkcert create-cert --ca-key ca.key --ca-cert ca.crt --validity 365 --domains "localhost,$LOCAL_IP"

# Step 4: organize the certificate files
echo "[4/7] Organizing certificate files..."
mkdir -p "$CERT_DIR"
mv ca.key ca.crt cert.key cert.crt "$CERT_DIR/"

# Step 5: create the HTTPS server file
echo "[5/7] Creating HTTPS server file..."
cat > server.js << 'EOF'
const { createServer } = require('https');
const { parse } = require('url');
const next = require('next');
const fs = require('fs');
const path = require('path');

const dev = process.env.NODE_ENV !== 'production';
const hostname = '0.0.0.0';
const port = process.env.PORT || 3000;

const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();

const httpsOptions = {
  key: fs.readFileSync(path.join(__dirname, 'certs', 'cert.key')),
  cert: fs.readFileSync(path.join(__dirname, 'certs', 'cert.crt')),
};

app.prepare().then(() => {
  createServer(httpsOptions, async (req, res) => {
    try {
      const parsedUrl = parse(req.url, true);
      await handle(req, res, parsedUrl);
    } catch (err) {
      console.error('Error occurred while handling', req.url, err);
      res.statusCode = 500;
      res.end('internal server error');
    }
  }).listen(port, () => {
    console.log(`> Ready on https://${hostname}:${port}`);
    console.log(`> Local: https://localhost:${port}`);
  });
});
EOF

# Step 6: add the npm script
echo "[6/7] Adding npm script..."
if ! grep -q '"dev:https"' package.json; then
    # Use Node to modify package.json
    node -e "
const fs = require('fs');
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
pkg.scripts = pkg.scripts || {};
pkg.scripts['dev:https'] = 'node server.js';
fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
"
    echo "   Added dev:https script"
else
    echo "   dev:https script already exists"
fi

# Step 7: add the cert directory to .gitignore
echo "[7/7] Updating .gitignore..."
if [ -f .gitignore ]; then
    if ! grep -q "certs/" .gitignore; then
        echo -e "\n# SSL certificates\ncerts/" >> .gitignore
    fi
else
    echo -e "# SSL certificates\ncerts/" > .gitignore
fi

echo ""
echo "=========================================="
echo "  Setup complete!"
echo "=========================================="
echo ""
echo "Run the HTTPS server:"
echo "  npm run dev:https"
echo ""
echo "Access URLs:"
echo "  Local: https://localhost:$PORT"
echo "  LAN: https://$LOCAL_IP:$PORT"
echo ""
echo "Note: the first visit will require you to accept the self-signed certificate warning in the browser"
echo ""
