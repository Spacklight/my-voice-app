import { useState, useRef, useCallback } from 'react';
import './App.css';

function App() {
  const [meetingId, setMeetingId] = useState('');
  const [error, setError] = useState('');
  const [joined, setJoined] = useState(false);
  const [isHost, setIsHost] = useState(false);
  const [partnerLeft, setPartnerLeft] = useState(false);
  const [micOn, setMicOn] = useState(true);
  const [camOn, setCamOn] = useState(true);

  // WebSocket and WebRTC refs
  const wsRef = useRef<WebSocket | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);

  const joinRoom = useCallback(async (role: 'host' | 'participant') => {
    if (!meetingId.trim()) {
      setError('Please enter a meeting ID');
      return;
    }

    setError('');

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      localStreamRef.current = stream;
      if (localVideoRef.current) {
        localVideoRef.current.srcObject = stream;
      }

      const ws = new WebSocket(`wss://${window.location.host}/ws?room=${encodeURIComponent(meetingId)}`);
      wsRef.current = ws;

      ws.onopen = () => {
        console.log('WebSocket connected, sending join as', role);
        ws.send(JSON.stringify({ type: 'join', role }));
      };

      ws.onmessage = async (event) => {
        const data = JSON.parse(event.data);

        if (data.type === 'error') {
          setError(data.message);
          ws.close();
          return;
        }

        if (data.type === 'joined') {
          console.log('Joined room:', data.room);
          setIsHost(data.isHost);
          setJoined(true);
        }

        if (data.type === 'peer_joined') {
          console.log('Peer joined');
          setPartnerLeft(false);
          await createPeerConnection(stream);
          const offer = await pcRef.current!.createOffer();
          await pcRef.current!.setLocalDescription(offer);
          ws.send(JSON.stringify({ type: 'offer', sdp: offer.sdp }));
        }

        if (data.type === 'offer') {
          console.log('Received offer');
          setPartnerLeft(false);
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

        if (data.type === 'become_host') {
          setIsHost(true);
        }

        // --- Fix: the Worker sends this on disconnect but it was never handled ---
        if (data.type === 'peer_left') {
          console.log('Peer left the room');
          setPartnerLeft(true);
          pcRef.current?.close();
          pcRef.current = null;
          if (remoteVideoRef.current) {
            remoteVideoRef.current.srcObject = null;
          }
        }
      };

      ws.onclose = () => {
        console.log('WebSocket closed');
        setJoined(false);
        setIsHost(false);
        setPartnerLeft(false);
        pcRef.current?.close();
        pcRef.current = null;
      };

      ws.onerror = () => {
        setError('Failed to connect to meeting. Please check your meeting ID.');
      };
    } catch (err) {
      console.error(err);
      setError('Failed to access camera/microphone. Please grant permissions.');
    }
  }, [meetingId]);

  const createPeerConnection = async (stream: MediaStream) => {
    const pc = new RTCPeerConnection({
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' },
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

  const toggleMic = () => {
    const stream = localStreamRef.current;
    if (!stream) return;
    const next = !micOn;
    stream.getAudioTracks().forEach(track => { track.enabled = next; });
    setMicOn(next);
  };

  const toggleCam = () => {
    const stream = localStreamRef.current;
    if (!stream) return;
    const next = !camOn;
    stream.getVideoTracks().forEach(track => { track.enabled = next; });
    setCamOn(next);
  };

  const leaveRoom = () => {
    if (isHost) {
      wsRef.current?.send(JSON.stringify({ type: 'host_leaving' }));
    }
    wsRef.current?.close();
    pcRef.current?.close();
    pcRef.current = null;
    setJoined(false);
    setIsHost(false);
    setPartnerLeft(false);
    setMicOn(true);
    setCamOn(true);
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach(t => t.stop());
      localStreamRef.current = null;
    }
    if (localVideoRef.current) {
      localVideoRef.current.srcObject = null;
    }
    if (remoteVideoRef.current) {
      remoteVideoRef.current.srcObject = null;
    }
  };

  if (!joined) {
    return (
      <div style={{ padding: '40px', maxWidth: '400px', margin: '0 auto', textAlign: 'center' }}>
        <h1>Collaborative C++ Compiler</h1>
        <p style={{ marginBottom: '20px', color: '#666' }}>
          Host a meeting or join an existing one
        </p>

        {error && (
          <div style={{
            background: '#ffebee',
            color: '#c62828',
            padding: '10px',
            borderRadius: '4px',
            marginBottom: '15px',
            border: '1px solid #ef9a9a',
          }}>
            {error}
          </div>
        )}

        <input
          type="text"
          placeholder="Enter meeting ID"
          value={meetingId}
          onChange={(e) => {
            setMeetingId(e.target.value);
            setError('');
          }}
          style={{
            width: '100%',
            padding: '12px',
            fontSize: '16px',
            border: '1px solid #ddd',
            borderRadius: '4px',
            marginBottom: '12px',
            boxSizing: 'border-box',
          }}
        />

        <div style={{ display: 'flex', gap: '10px' }}>
          <button
            onClick={() => joinRoom('host')}
            style={{
              flex: 1,
              padding: '12px',
              background: '#1976d2',
              color: 'white',
              border: 'none',
              borderRadius: '4px',
              fontSize: '16px',
              cursor: 'pointer',
            }}
          >
            Host Meeting
          </button>
          <button
            onClick={() => joinRoom('participant')}
            style={{
              flex: 1,
              padding: '12px',
              background: '#388e3c',
              color: 'white',
              border: 'none',
              borderRadius: '4px',
              fontSize: '16px',
              cursor: 'pointer',
            }}
          >
            Join Meeting
          </button>
        </div>
      </div>
    );
  }

  return (
    <div style={{ padding: '20px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '15px' }}>
        <div>
          <h2 style={{ margin: 0 }}>
            Meeting: <span style={{ color: '#1976d2' }}>{meetingId}</span>
          </h2>
          <p style={{ margin: '5px 0 0', color: '#666' }}>
            {isHost ? '👑 You are the host' : '👤 You are a participant'}
          </p>
        </div>
        <button
          onClick={leaveRoom}
          style={{
            padding: '10px 20px',
            background: '#d32f2f',
            color: 'white',
            border: 'none',
            borderRadius: '4px',
            cursor: 'pointer',
          }}
        >
          Leave Meeting
        </button>
      </div>

      {/* New: shows up when the Worker reports the other side disconnected */}
      {partnerLeft && (
        <div style={{
          background: '#fff3e0',
          color: '#e65100',
          padding: '10px 14px',
          borderRadius: '4px',
          marginBottom: '15px',
          border: '1px solid #ffcc80',
        }}>
          🔌 The other participant has left the meeting.
        </div>
      )}

      <div style={{
        border: '1px solid #ddd',
        borderRadius: '8px',
        overflow: 'hidden',
        background: '#fff',
        marginBottom: '15px',
      }}>
        <iframe
          src="https://emalawi19-cpp-online-compiler.hf.space"
          frameBorder="0"
          width="100%"
          height="600px"
          title="C++ Compiler"
          style={{ display: 'block' }}
          allow="microphone; camera; clipboard-write;"
        />
      </div>

      <div style={{ display: 'flex', gap: '20px', marginTop: '20px' }}>
        <div style={{ flex: 1 }}>
          <h3>You</h3>
          <video ref={localVideoRef} autoPlay muted style={{ width: '100%', maxWidth: '300px', background: '#222' }} />
        </div>
        <div style={{ flex: 1 }}>
          <h3>Remote</h3>
          <video ref={remoteVideoRef} autoPlay style={{ width: '100%', maxWidth: '300px', background: '#222' }} />
        </div>
      </div>

      {/* New: mic / camera controls */}
      <div style={{ display: 'flex', justifyContent: 'center', gap: '12px', marginTop: '16px' }}>
        <button
          onClick={toggleMic}
          style={{
            padding: '10px 18px',
            borderRadius: '24px',
            border: 'none',
            cursor: 'pointer',
            fontSize: '15px',
            background: micOn ? '#eeeeee' : '#d32f2f',
            color: micOn ? '#333' : '#fff',
          }}
        >
          {micOn ? '🎤 Mute' : '🔇 Unmute'}
        </button>
        <button
          onClick={toggleCam}
          style={{
            padding: '10px 18px',
            borderRadius: '24px',
            border: 'none',
            cursor: 'pointer',
            fontSize: '15px',
            background: camOn ? '#eeeeee' : '#d32f2f',
            color: camOn ? '#333' : '#fff',
          }}
        >
          {camOn ? '📷 Stop Video' : '📷 Start Video'}
        </button>
      </div>
    </div>
  );
}

export default App;
