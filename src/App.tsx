import { useState, useRef, useCallback } from 'react';
import './App.css';

function App() {
  const [room, setRoom] = useState('');
  const [joined, setJoined] = useState(false);
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);

  const joinRoom = useCallback(async () => {
    if (!room) return;

    // Get local media
    const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    if (localVideoRef.current) {
      localVideoRef.current.srcObject = stream;
    }

    // Connect to WebSocket
    const ws = new WebSocket(`wss://${window.location.host}/ws`);
    wsRef.current = ws;

    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'join', room }));
    };

    ws.onmessage = async (event) => {
      const data = JSON.parse(event.data);

      if (data.type === 'joined') {
        console.log('Joined room:', data.room);
        setJoined(true);
      }

      if (data.type === 'peer_joined') {
        // Create a peer connection and send an offer
        await createPeerConnection(stream);
        const offer = await pcRef.current!.createOffer();
        await pcRef.current!.setLocalDescription(offer);
        ws.send(JSON.stringify({ type: 'offer', sdp: offer.sdp }));
      }

      if (data.type === 'offer') {
        await createPeerConnection(stream);
        await pcRef.current!.setRemoteDescription({ type: 'offer', sdp: data.sdp });
        const answer = await pcRef.current!.createAnswer();
        await pcRef.current!.setLocalDescription(answer);
        ws.send(JSON.stringify({ type: 'answer', sdp: answer.sdp }));
      }

      if (data.type === 'answer') {
        await pcRef.current!.setRemoteDescription({ type: 'answer', sdp: data.sdp });
      }

      if (data.type === 'ice-candidate') {
        if (pcRef.current) {
          await pcRef.current.addIceCandidate(new RTCIceCandidate(data.candidate));
        }
      }
    };

    ws.onclose = () => {
      console.log('WebSocket closed');
      setJoined(false);
    };
  }, [room]);

  const createPeerConnection = async (stream: MediaStream) => {
    const pc = new RTCPeerConnection({
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
      ],
    });
    pcRef.current = pc;

    stream.getTracks().forEach(track => {
      pc.addTrack(track, stream);
    });

    pc.ontrack = (event) => {
      if (remoteVideoRef.current) {
        remoteVideoRef.current.srcObject = event.streams[0];
      }
    };

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        wsRef.current?.send(JSON.stringify({
          type: 'ice-candidate',
          candidate: event.candidate,
        }));
      }
    };

    return pc;
  };

  const leaveRoom = () => {
    wsRef.current?.close();
    pcRef.current?.close();
    pcRef.current = null;
    setJoined(false);
    if (localVideoRef.current && localVideoRef.current.srcObject) {
      (localVideoRef.current.srcObject as MediaStream).getTracks().forEach(t => t.stop());
      localVideoRef.current.srcObject = null;
    }
    if (remoteVideoRef.current) {
      remoteVideoRef.current.srcObject = null;
    }
  };

  return (
    <div style={{ padding: '20px' }}>
      <h1>Live Voice/Video Chat</h1>
      {!joined ? (
        <div>
          <input
            type="text"
            placeholder="Enter room name"
            value={room}
            onChange={(e) => setRoom(e.target.value)}
            style={{ padding: '10px', marginRight: '10px' }}
          />
          <button onClick={joinRoom} style={{ padding: '10px' }}>
            Join Room
          </button>
        </div>
      ) : (
        <div>
          <p>Connected to room: <strong>{room}</strong></p>
          <button onClick={leaveRoom} style={{ padding: '10px', background: 'red', color: 'white' }}>
            Leave Room
          </button>
          <div style={{ display: 'flex', gap: '20px', marginTop: '20px' }}>
            <div>
              <h3>You (local)</h3>
              <video ref={localVideoRef} autoPlay muted style={{ width: '300px', background: '#222' }} />
            </div>
            <div>
              <h3>Remote</h3>
              <video ref={remoteVideoRef} autoPlay style={{ width: '300px', background: '#222' }} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
