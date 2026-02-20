# HTTPS Setup for Test UI

The test UI server runs over HTTPS so that browser APIs requiring a secure context (like the Web Speech API for microphone input) work correctly.

## Why HTTPS?

The browser's `SpeechRecognition` API is only available in [secure contexts](https://developer.mozilla.org/en-US/docs/Web/Security/Secure_Contexts). Serving the page over plain HTTP blocks microphone access entirely.

## How It Works

`server.js` runs an HTTPS Node.js server on port 5555 using a self-signed certificate. It also acts as a **reverse proxy** for Django API calls — the browser sends all requests to the HTTPS server, which forwards `/deployment/`, `/chatbot/`, and `/api/` paths to the Django backend at `http://192.168.1.221:8000` internally. This avoids mixed-content and CORS errors that occur when an HTTPS page calls an HTTP endpoint directly.

```
Browser (HTTPS)  →  test-ui server :5555 (HTTPS)  →  Django :8000 (HTTP, internal)
```

## Setup Steps

### 1. Generate a self-signed certificate

Run once from the `docker/test-ui/` directory:

```bash
openssl req -x509 -newkey rsa:2048 -keyout key.pem -out cert.pem -days 365 -nodes -config ssl.cnf
```

`ssl.cnf` sets the Subject Alternative Name (SAN) for the local IP so the browser accepts the cert:

```ini
[req]
default_bits = 2048
prompt = no
default_md = sha256
distinguished_name = dn
x509_extensions = v3_req

[dn]
CN = 192.168.1.221

[v3_req]
subjectAltName = @alt_names

[alt_names]
IP.1 = 192.168.1.221
IP.2 = 127.0.0.1
DNS.1 = localhost
```

The generated `key.pem` and `cert.pem` are loaded by `server.js` at startup.

### 2. Start the server

```bash
node docker/test-ui/server.js
```

### 3. Accept the self-signed certificate in the browser

Open `https://192.168.1.221:5555` and click **Advanced → Proceed** to trust the certificate. You only need to do this once per browser profile.

### 4. API URL

The API endpoint field in the UI should point to the proxy (same origin), not directly to Django:

```
https://192.168.1.221:5555/deployment/api/mock_org/mbn_api/
```

This is the default value already set in `index.html`.

## Regenerating the Certificate

The cert expires after 365 days. To regenerate:

```bash
cd docker/test-ui
openssl req -x509 -newkey rsa:2048 -keyout key.pem -out cert.pem -days 365 -nodes -config ssl.cnf
node server.js
```
