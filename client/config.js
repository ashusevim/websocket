/*
 * Deployment configuration for the static client.
 *
 * This file is the one place to edit when the client and the API live on
 * different hosts — which they do once you attach a custom domain. Leaving it
 * empty is correct for local development, where both are served from localhost
 * on different ports.
 *
 * Examples:
 *   window.SERVER_HOST = 'api.example.com';          // custom domain
 *   window.SERVER_HOST = 'websocket-chat-server-abc123.onrender.com'; // Render
 *   window.SERVER_HOST = '';                         // same origin as the page
 *
 * A host may include a port for local work ("localhost:8080"). Do not include a
 * scheme: the client derives https/wss automatically, and a scheme here is the
 * most common cause of a connection that never opens.
 */
window.SERVER_HOST = '';