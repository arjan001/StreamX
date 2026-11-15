# APK Download Server Setup — apk.lovix.com

Run these commands via SSH on your VPS (83.229.83.91) to set up the APK download server.

## 1. Create the web directory

```bash
sudo mkdir -p /var/www/apk.lovix.com
sudo chown www-data:www-data /var/www/apk.lovix.com
sudo chmod 755 /var/www/apk.lovix.com
```

## 2. Create the Nginx server block

```bash
sudo tee /etc/nginx/sites-available/apk.lovix.com > /dev/null << 'EOF'
server {
    listen 80;
    server_name apk.lovix.com;

    root /var/www/apk.lovix.com;
    index index.html;

    # Allow large file downloads (APKs can be 100MB+)
    client_max_body_size 200M;

    # Enable gzip for HTML/JSON
    gzip on;
    gzip_types text/html application/json;

    # Security headers
    add_header X-Content-Type-Options nosniff;
    add_header X-Frame-Options DENY;

    # Serve APK files with correct content type
    location ~* \.apk$ {
        add_header Content-Type application/vnd.android.package-archive;
        add_header Cache-Control "public, max-age=3600";
    }

    # Serve the release.json API
    location /api/ {
        add_header Access-Control-Allow-Origin *;
        add_header Cache-Control "no-cache";
    }

    location / {
        try_files $uri $uri/ =404;
    }
}
EOF
```

## 3. Enable the site

```bash
sudo ln -sf /etc/nginx/sites-available/apk.lovix.com /etc/nginx/sites-enabled/apk.lovix.com
sudo nginx -t
sudo systemctl reload nginx
```

## 4. Set up SSH key-based access for CI deployment

The CI workflow will use SSH to upload APKs. Add the GitHub Actions deploy key:

```bash
sudo mkdir -p /var/www/apk.lovix.com/.ssh
sudo chmod 700 /var/www/apk.lovix.com/.ssh

# Create a deploy user (optional, for security)
sudo useradd -r -s /bin/false apkdeploy 2>/dev/null || true
sudo mkdir -p /home/apkdeploy/.ssh
sudo chmod 700 /home/apkdeploy/.ssh
```

Then add the public key (generated in GitHub repo secrets) to:
```
/home/apkdeploy/.ssh/authorized_keys
```

## 5. DNS Configuration

Add an A record in your DNS settings for lovix.com:
- **Type:** A
- **Name:** apk
- **Value:** 83.229.83.91

Wait for DNS propagation (usually 5-30 minutes).

## 6. Test the setup

```bash
curl http://apk.lovix.com/
# Should return 404 (no index.html yet) or the download page once deployed
```

## 7. GitHub Repository Secrets

In your GitHub repository settings, add these secrets:
- `APK_SERVER_HOST` — `apk.lovix.com` or `83.229.83.91`
- `APK_SERVER_USER` — The SSH user (e.g., `arjan` or `apkdeploy`)
- `APK_SERVER_KEY` — The private SSH key for deployment
- `APK_SERVER_PATH` — `/var/www/apk.lovix.com`

## 8. SSL (Optional but recommended)

```bash
sudo apt install certbot python3-certbot-nginx
sudo certbot --nginx -d apk.lovix.com
```

This will automatically configure HTTPS and redirect HTTP to HTTPS.
