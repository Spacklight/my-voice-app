export interface Env {
  ROOM_DO: DurableObjectNamespace;
}

export class RoomDO {
  private roomName: string;
  private clients: Set<WebSocket> = new Set();
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
    this.clients.add(server);

    const isHost = this.host === null;
    if (isHost) {
      this.host = server;
    }

    server.send(JSON.stringify({
      type: 'joined',
      room: this.roomName,
      isHost: isHost,
    }));

    // Notify existing clients that a new peer joined
    for (const clientSocket of this.clients) {
      if (clientSocket !== server) {
        clientSocket.send(JSON.stringify({ type: 'peer_joined' }));
      }
    }

    server.addEventListener('message', (event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data as string);

        // WebRTC signaling
        if (['offer', 'answer', 'ice-candidate'].includes(data.type)) {
          for (const clientSocket of this.clients) {
            if (clientSocket !== server) {
              clientSocket.send(JSON.stringify(data));
            }
          }
        }

        // PDF upload: only host can send, relay to all others
        if (data.type === 'pdf_upload') {
          if (server === this.host) {
            for (const clientSocket of this.clients) {
              if (clientSocket !== server) {
                clientSocket.send(JSON.stringify({
                  type: 'pdf_upload',
                  dataUrl: data.dataUrl,
                }));
              }
            }
          }
        }

        // Viewport sync: only host can send
        if (data.type === 'viewport') {
          if (server === this.host) {
            for (const clientSocket of this.clients) {
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
            for (const clientSocket of this.clients) {
              if (clientSocket !== server) {
                this.host = clientSocket;
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
        for (const clientSocket of this.clients) {
          this.host = clientSocket;
          clientSocket.send(JSON.stringify({ type: 'become_host' }));
          break;
        }
      }
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
