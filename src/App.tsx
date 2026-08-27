import { useState, useRef, useCallback } from 'react';
import { Document, Page, pdfjs } from 'react-pdf';
import './App.css';

pdfjs.GlobalWorkerOptions.workerSrc = `//cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjs.version}/pdf.worker.min.js`;

function App() {
  const [meetingId, setMeetingId] = useState('');
  const [error, setError] = useState('');
  const [joined, setJoined] = useState(false);
  const [isHost, setIsHost] = useState(false);

  // PDF state
  const [pdfBlobUrl, setPdfBlobUrl] = useState<string | null>(null);
  const [numPages, setNumPages] = useState<number | null>(null);
  const [pageNumber, setPageNumber] = useState(1);
  const [scale, setScale] = useState(1.0);

  // WebRTC refs
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const pdfContainerRef = useRef<HTMLDivElement>(null);

  const joinRoom = useCallback(async (role: 'host' | 'participant') => {
    if (!meetingId.trim()) {
      setError('Please enter a meeting ID');
      return;
    }

    setError('');

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
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

        if (data.type === 'pdf_upload') {
          console.log('Received PDF from host');
          // Convert base64 to Blob and create URL
          try {
            const base64 = data.dataUrl.split(',')[1];
            const binary = atob(base64);
            const array = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i++) {
              array[i] = binary.charCodeAt(i);
            }
            const blob = new Blob([array], { type: 'application/pdf' });
            const blobUrl = URL.createObjectURL(blob);
            setPdfBlobUrl(blobUrl);
          } catch (err) {
            console.error('Failed to load PDF from host:', err);
            setError('Failed to load PDF from host');
          }
        }

        if (data.type === 'peer_joined') {
          console.log('Peer joined');
          await createPeerConnection(stream);
          const offer = await pcRef.current!.createOffer();
          await pcRef.current!.setLocalDescription(offer);
          ws.send(JSON.stringify({ type: 'offer', sdp: offer.sdp }));
        }

        if (data.type === 'peer_left') {
          console.log('Peer left');
          pcRef.current?.close();
          pcRef.current = null;
          if (remoteVideoRef.current) {
            remoteVideoRef.current.srcObject = null;
          }
        }

        if (data.type === 'offer') {
          console.log('Received offer');
          await createPeerConnection(stream);
          await pcRef.current!.setRemoteDescription({ type: 'offer', sdp: data.sdp });
          const answer = await pcRef.current!.createAnswer();
          await pcRef.current!.setLocalDescription(answer);
          ws.send(JSON.stringify({ type: 'answer', sdp: answer.sdp }));
        }

        if (data.type === 'answer') {
          console.log('Received answer');
          await pcRef.current!.setRemoteDescription({ type: 'answer', sdp: data.sdp });
        }

        if (data.type === 'ice-candidate') {
          console.log('Received ICE candidate');
          if (pcRef.current) {
            await pcRef.current.addIceCandidate(new RTCIceCandidate(data.candidate));
          }
        }

        if (data.type === 'viewport') {
          console.log('Received viewport update:', data.viewport);
          setPageNumber(data.viewport.pageNumber || 1);
          setScale(data.viewport.scale || 1.0);
        }

        if (data.type === 'become_host') {
          console.log('You are now the host!');
          setIsHost(true);
        }
      };

      ws.onclose = () => {
        console.log('WebSocket closed');
        setJoined(false);
        setIsHost(false);
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
      console.log('Received remote track');
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
    if (isHost) {
      wsRef.current?.send(JSON.stringify({ type: 'host_leaving' }));
    }
    wsRef.current?.close();
    pcRef.current?.close();
    pcRef.current = null;
    setJoined(false);
    setIsHost(false);
    if (localVideoRef.current && localVideoRef.current.srcObject) {
      (localVideoRef.current.srcObject as MediaStream).getTracks().forEach(t => t.stop());
      localVideoRef.current.srcObject = null;
    }
    if (remoteVideoRef.current) {
      remoteVideoRef.current.srcObject = null;
    }
    // Revoke PDF object URL to free memory
    if (pdfBlobUrl) {
      URL.revokeObjectURL(pdfBlobUrl);
      setPdfBlobUrl(null);
    }
  };

  const handlePdfUpload = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    // Check file size (max 900 KB to stay safely under 1 MB WebSocket limit)
    if (file.size > 1.5 * 1024 * 1024) {
      setError('PDF file is too large (max 1.5 MB)');
      return;
    }

    const reader = new FileReader();
    reader.onload = (e) => {
      const dataUrl = e.target?.result as string;
      // Create blob URL for local preview
      const blobUrl = URL.createObjectURL(file);
      setPdfBlobUrl(blobUrl);
      // Send to all participants
      if (wsRef.current) {
        wsRef.current.send(JSON.stringify({
          type: 'pdf_upload',
          dataUrl: dataUrl,
        }));
      }
    };
    reader.readAsDataURL(file);
  };

  const onDocumentLoadSuccess = ({ numPages }: { numPages: number }) => {
    setNumPages(numPages);
  };

  const onPageChange = (page: number) => {
    if (isHost && wsRef.current) {
      setPageNumber(page);
      wsRef.current.send(JSON.stringify({
        type: 'viewport',
        viewport: { pageNumber: page, scale: scale },
      }));
    }
  };

  const onScaleChange = (newScale: number) => {
    if (isHost && wsRef.current) {
      setScale(newScale);
      wsRef.current.send(JSON.stringify({
        type: 'viewport',
        viewport: { pageNumber: pageNumber, scale: newScale },
      }));
    }
  };

  if (!joined) {
    return (
      <div style={{ padding: '40px', maxWidth: '400px', margin: '0 auto', textAlign: 'center' }}>
        <h1>PDF Meeting</h1>
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

      {isHost && (
        <div style={{ marginBottom: '15px' }}>
          <label
            htmlFor="pdf-upload"
            style={{
              display: 'inline-block',
              padding: '10px 20px',
              background: '#1976d2',
              color: 'white',
              borderRadius: '4px',
              cursor: 'pointer',
            }}
          >
            Upload PDF
          </label>
          <input
            id="pdf-upload"
            type="file"
            accept="application/pdf"
            onChange={handlePdfUpload}
            style={{ display: 'none' }}
          />
          {pdfBlobUrl && <span style={{ marginLeft: '10px', color: '#388e3c' }}>✅ PDF loaded</span>}
        </div>
      )}

      <div style={{
        border: '1px solid #ddd',
        borderRadius: '8px',
        overflow: 'hidden',
        background: '#f5f5f5',
        marginBottom: '15px',
        position: 'relative',
      }}>
        <div
          ref={pdfContainerRef}
          style={{
            height: '500px',
            overflow: 'auto',
            padding: '20px',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
          }}
        >
          {pdfBlobUrl ? (
            <Document
              file={pdfBlobUrl}
              onLoadSuccess={onDocumentLoadSuccess}
              onLoadError={() => setError('Failed to load PDF file')}
            >
              <Page
                pageNumber={pageNumber}
                scale={scale}
                renderTextLayer={false}
                renderAnnotationLayer={false}
              />
            </Document>
          ) : (
            <p style={{ color: '#999' }}>
              {isHost ? 'Upload a PDF to start presenting' : 'Waiting for host to upload a PDF...'}
            </p>
          )}
        </div>

        {isHost && pdfBlobUrl && (
          <div style={{
            position: 'absolute',
            bottom: '20px',
            left: '50%',
            transform: 'translateX(-50%)',
            background: 'rgba(0,0,0,0.7)',
            padding: '10px 15px',
            borderRadius: '8px',
            display: 'flex',
            gap: '10px',
            alignItems: 'center',
            color: 'white',
          }}>
            <button
              onClick={() => onPageChange(Math.max(1, pageNumber - 1))}
              style={{
                padding: '5px 12px',
                background: '#555',
                color: 'white',
                border: 'none',
                borderRadius: '4px',
                cursor: 'pointer',
              }}
            >
              Prev
            </button>
            <span>
              Page {pageNumber} of {numPages || '?'}
            </span>
            <button
              onClick={() => onPageChange(Math.min(numPages || 1, pageNumber + 1))}
              style={{
                padding: '5px 12px',
                background: '#555',
                color: 'white',
                border: 'none',
                borderRadius: '4px',
                cursor: 'pointer',
              }}
            >
              Next
            </button>
            <span style={{ marginLeft: '10px' }}>Zoom:</span>
            <button
              onClick={() => onScaleChange(Math.max(0.5, scale - 0.1))}
              style={{
                padding: '5px 10px',
                background: '#555',
                color: 'white',
                border: 'none',
                borderRadius: '4px',
                cursor: 'pointer',
              }}
            >
              -
            </button>
            <span>{Math.round(scale * 100)}%</span>
            <button
              onClick={() => onScaleChange(Math.min(2.0, scale + 0.1))}
              style={{
                padding: '5px 10px',
                background: '#555',
                color: 'white',
                border: 'none',
                borderRadius: '4px',
                cursor: 'pointer',
              }}
            >
              +
            </button>
          </div>
        )}
      </div>

      <div style={{ display: 'flex', gap: '20px' }}>
        <div style={{ flex: 1 }}>
          <h3>You</h3>
          <video ref={localVideoRef} autoPlay muted style={{ width: '100%', maxWidth: '300px', background: '#222' }} />
        </div>
        <div style={{ flex: 1 }}>
          <h3>Remote</h3>
          <video ref={remoteVideoRef} autoPlay style={{ width: '100%', maxWidth: '300px', background: '#222' }} />
        </div>
      </div>
    </div>
  );
}

export default App;
