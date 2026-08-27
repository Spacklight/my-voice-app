export interface Env {
  ROOM_DO: DurableObjectNamespace;
}

export class RoomDO {
  private roomName: string;
  private clients: Map<WebSocket, string> = new Map();
  private host: WebSocket | null = null;

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

    server.accept();

    let roleReceived = false;

    server.addEventListener('message', (event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data as string);

        if (!roleReceived) {
          if (data.type !== 'join' || !data.role) {
            server.send(JSON.stringify({ type: 'error', message: 'First message must be join with role' }));
            server.close();
            return;
          }

          const role = data.role;
          roleReceived = true;

          if (role === 'host') {
            if (this.host !== null) {
              server.send(JSON.stringify({ type: 'error', message: 'Host already exists in this room' }));
              server.close();
              return;
            }
            this.host = server;
            this.clients.set(server, 'host');
            server.send(JSON.stringify({
              type: 'joined',
              room: this.roomName,
              isHost: true,
            }));
            // Notify existing clients that a host joined
            for (const [clientSocket] of this.clients) {
              if (clientSocket !== server) {
                clientSocket.send(JSON.stringify({ type: 'peer_joined' }));
              }
            }
            return;
          }

          if (role === 'participant') {
            if (this.host === null) {
              server.send(JSON.stringify({ type: 'error', message: 'incorrect meeting id or host not available' }));
              server.close();
              return;
            }
            this.clients.set(server, 'participant');
            server.send(JSON.stringify({
              type: 'joined',
              room: this.roomName,
              isHost: false,
            }));
            // Notify other clients that a participant joined
            for (const [clientSocket] of this.clients) {
              if (clientSocket !== server) {
                clientSocket.send(JSON.stringify({ type: 'peer_joined' }));
              }
            }
            return;
          }

          server.send(JSON.stringify({ type: 'error', message: 'Invalid role' }));
          server.close();
          return;
        }

        // Regular messages after join
        // WebRTC signaling
        if (['offer', 'answer', 'ice-candidate'].includes(data.type)) {
          for (const [clientSocket] of this.clients) {
            if (clientSocket !== server) {
              clientSocket.send(JSON.stringify(data));
            }
          }
        }

        // PDF URL: only host can send
        if (data.type === 'pdf_url') {
          if (server === this.host) {
            for (const [clientSocket] of this.clients) {
              if (clientSocket !== server) {
                clientSocket.send(JSON.stringify({
                  type: 'pdf_url',
                  url: data.url,
                }));
              }
            }
          }
        }

        // Viewport sync: only host can send
        if (data.type === 'viewport') {
          if (server === this.host) {
            for (const [clientSocket] of this.clients) {
              if (clientSocket !== server) {
                clientSocket.send(JSON.stringify({
                  type: 'viewport',
                  viewport: data.viewport,
                }));
              }
            }
          }
        }

        // Host leaving
        if (data.type === 'host_leaving') {
          if (server === this.host) {
            this.host = null;
            this.clients.delete(server);
            // Find a new host (first participant becomes host)
            for (const [clientSocket, role] of this.clients) {
              if (role === 'participant') {
                this.host = clientSocket;
                this.clients.set(clientSocket, 'host');
                clientSocket.send(JSON.stringify({ type: 'become_host' }));
                break;
              }
            }
          }
        }
      } catch (err) {
        // Ignore malformed messages
      }
    });

    server.addEventListener('close', () => {
      this.clients.delete(server);
      if (server === this.host) {
        this.host = null;
        // Find a new host
        for (const [clientSocket, role] of this.clients) {
          if (role === 'participant') {
            this.host = clientSocket;
            this.clients.set(clientSocket, 'host');
            clientSocket.send(JSON.stringify({ type: 'become_host' }));
            break;
          }
        }
      }
      for (const [clientSocket] of this.clients) {
        clientSocket.send(JSON.stringify({ type: 'peer_left' }));
      }
    });

    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/ws') {
      const roomName = url.searchParams.get('room') || 'default';
      const id = env.ROOM_DO.idFromName(roomName);
      const stub = env.ROOM_DO.get(id);
      return stub.fetch(request);
    }

    return new Response('Not found', { status: 404 });
  },
};

export { RoomDO as DurableObject };
