export interface Env {
  // No bindings needed for basic signaling
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Upgrade to WebSocket if the request is for /ws
    if (url.pathname === "/ws") {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);

      // Accept the WebSocket connection
      server.accept();

      // Store active rooms: roomName -> Set of WebSocket connections
      // Note: In a production app, you'd use a Durable Object for state persistence.
      // For simplicity, we use a global object (but note: Workers are stateless,
      // so this will not persist across multiple Worker instances.
      // For a demo or small-scale usage, it works if all connections hit the same isolate.
      // We'll use a Map attached to the server object.
      if (!server.rooms) {
        server.rooms = new Map<string, Set<WebSocket>>();
      }

      const rooms = server.rooms;

      let roomName: string | null = null;
      let peer: WebSocket | null = null;

      server.addEventListener("message", (event: MessageEvent) => {
        try {
          const data = JSON.parse(event.data as string);

          if (data.type === "join") {
            roomName = data.room;
            if (!rooms.has(roomName)) {
              rooms.set(roomName, new Set());
            }
            rooms.get(roomName)!.add(server);

            // Notify the client that they joined
            server.send(JSON.stringify({ type: "joined", room: roomName }));

            // If there is already a peer in this room, notify the new client
            const clients = rooms.get(roomName)!;
            if (clients.size > 1) {
              // Send a "peer_joined" message to both clients
              for (const clientSocket of clients) {
                if (clientSocket !== server) {
                  peer = clientSocket;
                  clientSocket.send(JSON.stringify({ type: "peer_joined" }));
                }
              }
            }
            return;
          }

          if (data.type === "offer" || data.type === "answer" || data.type === "ice-candidate") {
            // Relay the message to the other peer in the same room
            if (!roomName || !rooms.has(roomName)) return;
            const clients = rooms.get(roomName)!;
            for (const clientSocket of clients) {
              if (clientSocket !== server) {
                clientSocket.send(JSON.stringify(data));
              }
            }
          }
        } catch (err) {
          // Ignore malformed messages
        }
      });

      server.addEventListener("close", () => {
        // Remove the server from the room
        if (roomName && rooms.has(roomName)) {
          rooms.get(roomName)!.delete(server);
          if (rooms.get(roomName)!.size === 0) {
            rooms.delete(roomName);
          }
        }
      });

      return new Response(null, {
        status: 101,
        webSocket: client,
      });
    }

    // For any other path, serve the static assets (your React app)
    // Wrangler will handle static assets automatically via the `assets` binding.
    // If we reach here, just return a 404.
    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
