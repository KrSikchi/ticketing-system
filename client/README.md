# Ticketing client

React/Vite client for the existing backend API. It reads the numbered seat inventory from `GET /seats`, watches Socket.IO seat events, reserves a unit through `POST /hold`, then uses `POST /checkout` and `POST /pay` for the backend's mock checkout flow. It does not present pricing, event details, accounts, or payment fields because the backend does not provide them.

## Run locally

Start Redis, PostgreSQL, and the backend from `../backend`, then in this directory run:

```sh
npm install
npm run dev
```

Open `http://localhost:5173`. All HTTP requests use `VITE_API_BASE_URL` from the client `.env`; by default this is `/api`, which Vite proxies to `API_PROXY_TARGET` and strips before forwarding to the backend. Socket.IO connects directly to `VITE_SOCKET_URL`; the backend enables Socket.IO CORS. For a separately hosted API, update both URL values and configure HTTP CORS on the server; the current backend only configures CORS for Socket.IO.

The guest ID is stored in browser local storage and sent as `x-user-id`. This is the backend's demo identity mechanism, not authentication. Holds last for the duration returned by the backend (90 seconds by default) and expire automatically.