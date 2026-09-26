# BigBrandingCasting

## Frontend setup

Set `VITE_TOKEN_SERVER_URL` to the HTTPS URL of the deployed token server, ending in `/token`. See `.env.example` for the local format.

Do not put API keys, API secrets, or shared server secrets in `VITE_*` variables. Vite embeds those values in browser assets.

## Production deploy

Deploy this directory as a Vite app and set `VITE_TOKEN_SERVER_URL` in the hosting provider's build environment. Redeploy after changing environment variables. The token server's `CORS_ORIGIN` must include the exact public origin of this frontend.

The client tries the Cloud LiveKit endpoint first. If it fails, it cancels and disconnects that attempt before trying the fallback. A frontend served over HTTPS requires the fallback to use `wss://` with a valid TLS certificate and WebSocket proxying.

The current app has no user authentication. Its token endpoint therefore issues LiveKit tokens to anyone who can call it from an allowed browser origin; CORS is not authentication. Add an identity provider or another server-verified authorization mechanism before using this for private or paid broadcasts.
