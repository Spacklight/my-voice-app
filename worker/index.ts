export interface Env {
  ROOM_DO: DurableObjectNamespace;
}

// The Durable Object that manages a single room
export class RoomDO {
  private roomName: string;
  private clients: Set<WebSocket> = new Set();

  constructor(private state: DurableObjectState, env: Env) {
    this.roomName = state.id.toString();
  }

  async fetch(request: Request): Promise<Response> {
    const upgradeHeader = request.headers.get('Upgrade');
    if (upgradeHeader !== 'websocket') {
      return new Response('Expected WebSocket upgrade', { status: 400 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    // Accept the WebSocket connection
    server.accept();

    // Add this client to the room
    this.clients.add(server);

    // Notify the client that they joined
    server.send(JSON.stringify({ type: 'joined', room: this.roomName }));

    // If there is already a peer in this room, notify the new client
    if (this.clients.size > 1) {
      for (const clientSocket of this.clients) {
        if (clientSocket !== server) {
          clientSocket.send(JSON.stringify({ type: 'peer_joined' }));
        }
      }
    }

    // Handle messages from this client
    server.addEventListener('message', (event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data as string);

        // Relay the message to all other clients in the room
        for (const clientSocket of this.clients) {
          if (clientSocket !== server) {
            clientSocket.send(JSON.stringify(data));
          }
        }
      } catch (err) {
        // Ignore malformed messages
      }
    });

    server.addEventListener('close', () => {
      this.clients.delete(server);
      // Notify remaining clients that a peer left
      for (const clientSocket of this.clients) {
        clientSocket.send(JSON.stringify({ type: 'peer_left' }));
      }
    });

    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  }
}

// The Worker entry point
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Handle WebSocket upgrades via the Durable Object
    if (url.pathname === '/ws') {
      const roomName = url.searchParams.get('room') || 'default';
      const id = env.ROOM_DO.idFromName(roomName);
      const stub = env.ROOM_DO.get(id);
      return stub.fetch(request);
    }

    // For any other path, let the static assets handle it
    return new Response('Not found', { status: 404 });
  },
};

// Durable Object export for Cloudflare
export { RoomDO as DurableObject };
