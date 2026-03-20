#!/usr/bin/env bash

domain="conductor-ai.top"

ping $domain

echo "Make user http://${domain} is OK"

sudo apt update
sudo apt install -y certbot python3-certbot-nginx
certbot --version
sudo certbot --nginx -d ${domain}

echo "Test certbot renew timer"
sudo certbot renew --dry-run
systemctl list-timers | grep certbot
