import { useState, useRef, useCallback } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
import pdfjsWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import './App.css';

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsWorkerUrl;

async function renderPdfToImages(file: File): Promise<string[]> {
  const arrayBuffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  const images: string[] = [];

  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const viewport = page.getViewport({ scale: 1.5 });
    const canvas = document.createElement('canvas');
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) continue;
    await page.render({ canvasContext: ctx, viewport }).promise;
    images.push(canvas.toDataURL('image/jpeg', 0.8));
  }

  return images;
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error('Failed to read file'));
    reader.readAsDataURL(file);
  });
}

const navBtnStyle: React.CSSProperties = {
  padding: '6px 14px',
  borderRadius: '4px',
  border: '1px solid #ccc',
  background: '#fff',
  cursor: 'pointer',
  fontSize: '14px',
};

function App() {
  const [meetingId, setMeetingId] = useState('');
  const [error, setError] = useState('');
  const [joined, setJoined] = useState(false);
  const [isHost, setIsHost] = useState(false);
  const [partnerLeft, setPartnerLeft] = useState(false);
  const [micOn, setMicOn] = useState(true);
  const [camOn, setCamOn] = useState(true);
  const [screenSharing, setScreenSharing] = useState(false);
  const [screenShareError, setScreenShareError] = useState('');

  // Shared document (PDF/image) state
  const [docPages, setDocPages] = useState<string[]>([]);
  const [docPageIndex, setDocPageIndex] = useState(0);
  const [docLoading, setDocLoading] = useState(false);
  const [docError, setDocError] = useState('');

  // WebSocket and WebRTC refs
  const wsRef = useRef<WebSocket | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const screenStreamRef = useRef<MediaStream | null>(null);
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

        if (data.type === 'peer_left') {
          console.log('Peer left the room');
          setPartnerLeft(true);
          pcRef.current?.close();
          pcRef.current = null;
          if (remoteVideoRef.current) {
            remoteVideoRef.current.srcObject = null;
          }
          if (screenStreamRef.current) {
            screenStreamRef.current.getTracks().forEach(t => t.stop());
            screenStreamRef.current = null;
            setScreenSharing(false);
            if (localVideoRef.current && localStreamRef.current) {
              localVideoRef.current.srcObject = localStreamRef.current;
            }
          }
        }

        // Host shared a new document — everyone (including late joiners) receives this
        if (data.type === 'doc_share') {
          setDocPages(data.pages);
          setDocPageIndex(data.page ?? 0);
          setDocError('');
        }

        // Host navigated to a different page of the current document
        if (data.type === 'doc_nav') {
          setDocPageIndex(data.page);
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

  const stopScreenShare = useCallback(async () => {
    const screenStream = screenStreamRef.current;
    if (!screenStream) return;

    screenStream.getTracks().forEach(t => t.stop());
    screenStreamRef.current = null;

    const cameraTrack = localStreamRef.current?.getVideoTracks()[0] ?? null;
    const videoSender = pcRef.current?.getSenders().find(s => s.track?.kind === 'video');
    if (videoSender && cameraTrack) {
      await videoSender.replaceTrack(cameraTrack);
    }

    if (localVideoRef.current && localStreamRef.current) {
      localVideoRef.current.srcObject = localStreamRef.current;
    }

    setScreenSharing(false);
  }, []);

  const startScreenShare = async () => {
    if (!pcRef.current) {
      setScreenShareError('Waiting for the other participant to connect first.');
      return;
    }
    setScreenShareError('');

    try {
      const screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
      screenStreamRef.current = screenStream;
      const screenTrack = screenStream.getVideoTracks()[0];

      const videoSender = pcRef.current.getSenders().find(s => s.track?.kind === 'video');
      if (videoSender) {
        await videoSender.replaceTrack(screenTrack);
      }

      if (localVideoRef.current) {
        localVideoRef.current.srcObject = screenStream;
      }

      screenTrack.onended = () => {
        stopScreenShare();
      };

      setScreenSharing(true);
    } catch (err) {
      console.error(err);
      setScreenShareError('Screen share was cancelled or is not supported on this browser.');
    }
  };

  const toggleScreenShare = () => {
    if (screenSharing) {
      stopScreenShare();
    } else {
      startScreenShare();
    }
  };

  // --- Document sharing (host only) ---

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    setDocError('');
    setDocLoading(true);

    try {
      const fileArray = Array.from(files);
      const pdfFile = fileArray.find(f => f.type === 'application/pdf');
      const pages = pdfFile
        ? await renderPdfToImages(pdfFile)
        : await Promise.all(fileArray.map(readFileAsDataUrl));

      if (pages.length === 0) {
        setDocError('No pages could be loaded from that file.');
        return;
      }

      setDocPages(pages);
      setDocPageIndex(0);
      wsRef.current?.send(JSON.stringify({ type: 'doc_share', pages, page: 0 }));
    } catch (err) {
      console.error(err);
      setDocError('Could not load that file. Try a different PDF or image.');
    } finally {
      setDocLoading(false);
      e.target.value = '';
    }
  };

  const goToDocPage = (index: number) => {
    if (index < 0 || index >= docPages.length) return;
    setDocPageIndex(index);
    wsRef.current?.send(JSON.stringify({ type: 'doc_nav', page: index }));
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
    setScreenSharing(false);
    setScreenShareError('');
    setDocPages([]);
    setDocPageIndex(0);
    setDocError('');
    if (screenStreamRef.current) {
      screenStreamRef.current.getTracks().forEach(t => t.stop());
      screenStreamRef.current = null;
    }
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
        <h1>Collaborative Meeting Room</h1>
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

      {/* Document viewer replaces the old compiler iframe */}
      <div style={{
        border: '1px solid #ddd',
        borderRadius: '8px',
        overflow: 'hidden',
        background: '#fff',
        marginBottom: '15px',
        minHeight: '300px',
      }}>
        {isHost && (
          <div style={{
            padding: '12px',
            borderBottom: docPages.length > 0 ? '1px solid #eee' : 'none',
            display: 'flex',
            gap: '10px',
            alignItems: 'center',
            flexWrap: 'wrap',
          }}>
            <label style={{
              padding: '8px 14px',
              background: '#1976d2',
              color: '#fff',
              borderRadius: '4px',
              cursor: 'pointer',
              fontSize: '14px',
            }}>
              📎 Select File or Pictures
              <input
                type="file"
                accept="application/pdf,image/*"
                multiple
                onChange={handleFileSelect}
                style={{ display: 'none' }}
              />
            </label>

            {docLoading && <span style={{ color: '#666', fontSize: '14px' }}>Loading…</span>}

            {docPages.length > 0 && (
              <>
                <button
                  onClick={() => goToDocPage(docPageIndex - 1)}
                  disabled={docPageIndex === 0}
                  style={navBtnStyle}
                >
                  ◀ Prev
                </button>
                <span style={{ fontSize: '14px', color: '#666' }}>
                  Page {docPageIndex + 1} / {docPages.length}
                </span>
                <button
                  onClick={() => goToDocPage(docPageIndex + 1)}
                  disabled={docPageIndex === docPages.length - 1}
                  style={navBtnStyle}
                >
                  Next ▶
                </button>
              </>
            )}
          </div>
        )}

        {docError && (
          <p style={{ color: '#c62828', padding: '10px 14px', margin: 0 }}>{docError}</p>
        )}

        {docPages.length > 0 ? (
          <img
            src={docPages[docPageIndex]}
            alt={`Page ${docPageIndex + 1}`}
            style={{ width: '100%', display: 'block' }}
          />
        ) : (
          <p style={{ color: '#999', textAlign: 'center', padding: '60px 20px' }}>
            {isHost ? 'Select a PDF or picture above to share it with the meeting.' : 'Waiting for the host to share a document…'}
          </p>
        )}
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
        <button
          onClick={toggleScreenShare}
          style={{
            padding: '10px 18px',
            borderRadius: '24px',
            border: 'none',
            cursor: 'pointer',
            fontSize: '15px',
            background: screenSharing ? '#1976d2' : '#eeeeee',
            color: screenSharing ? '#fff' : '#333',
          }}
        >
          {screenSharing ? '🖥️ Stop Sharing' : '🖥️ Share Screen'}
        </button>
      </div>

      {screenShareError && (
        <p style={{ textAlign: 'center', color: '#c62828', marginTop: '10px', fontSize: '14px' }}>
          {screenShareError}
        </p>
      )}
    </div>
  );
}

export default App;
