'use client';
import { useEffect, useRef, useState } from 'react';
import { Modal } from './kit';

type Detector = { detect(source: HTMLVideoElement): Promise<{ rawValue: string }[]> };
type DetectorClass = { new (o: { formats: string[] }): Detector; getSupportedFormats(): Promise<string[]> };
const FORMATS = ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'qr_code'];

/** Lee códigos con la cámara: API nativa si existe; si no (iOS, algunos escritorios), ZXing. */
function CameraView({ onCode }: { onCode: (code: string) => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const callback = useRef(onCode);
  const [error, setError] = useState('');
  useEffect(() => { callback.current = onCode; }, [onCode]);

  useEffect(() => {
    let stopped = false;
    let stop = () => {};
    let last = { code: '', at: 0 };
    const emit = (code: string) => {
      if (code === last.code && Date.now() - last.at < 1800) return; // evita leer dos veces lo mismo
      last = { code, at: Date.now() };
      navigator.vibrate?.(60);
      callback.current(code);
    };
    (async () => {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('Este navegador no permite usar la cámara (requiere HTTPS).');
      const constraints = { video: { facingMode: { ideal: 'environment' } }, audio: false };
      const Native = (window as unknown as { BarcodeDetector?: DetectorClass }).BarcodeDetector;
      const supported = Native ? await Native.getSupportedFormats() : [];
      if (Native && supported.includes('ean_13')) {
        const stream = await navigator.mediaDevices.getUserMedia(constraints);
        stop = () => stream.getTracks().forEach((t) => t.stop());
        if (stopped || !video.current) return stop();
        video.current.srcObject = stream;
        await video.current.play();
        const detector = new Native({ formats: FORMATS.filter((f) => supported.includes(f)) });
        const loop = async () => {
          if (stopped || !video.current) return;
          const found = await detector.detect(video.current).catch(() => []);
          if (found[0]) emit(found[0].rawValue);
          setTimeout(loop, 200);
        };
        void loop();
      } else {
        const { BrowserMultiFormatReader } = await import('@zxing/browser');
        const controls = await new BrowserMultiFormatReader().decodeFromConstraints(constraints, video.current!, (result) => { if (result) emit(result.getText()); });
        stop = () => controls.stop();
        if (stopped) stop();
      }
    })().catch((e) => setError(e instanceof Error && e.name === 'NotAllowedError' ? 'Permite el acceso a la cámara para escanear.' : String(e.message ?? e)));
    return () => { stopped = true; stop(); };
  }, []);

  return error ? <p className="msg error">{error}</p> : <video ref={video} className="camera" muted playsInline />;
}

export function ScanButton({ onCode, label = 'Cámara', keepOpen = false }: { onCode: (code: string) => void; label?: string; keepOpen?: boolean }) {
  const [open, setOpen] = useState(false);
  const [last, setLast] = useState('');
  return (
    <>
      <button type="button" className="btn" onClick={() => { setOpen(true); setLast(''); }}>📷 {label}</button>
      {open && (
        <Modal title="Escanear código" onClose={() => setOpen(false)}>
          <CameraView onCode={(code) => { onCode(code); setLast(code); if (!keepOpen) setOpen(false); }} />
          {keepOpen && <p className="muted">{last ? `Leído: ${last}` : 'Apunta al código. Puedes escanear varios seguidos.'}</p>}
          <button type="button" className="btn primary" onClick={() => setOpen(false)}>Listo</button>
        </Modal>
      )}
    </>
  );
}
