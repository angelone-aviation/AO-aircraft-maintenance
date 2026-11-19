/**
 * Responsibility: The inventory scanner: reads a QR code with the camera, or
 *   a typed code, and opens the matching stock item or component.
 * Layer: UI. React components; codes resolve through src/domain.
 * Dependencies: react-dom, @tanstack/react-router, jsqr (loaded on demand),
 *   src/data/store.ts, src/domain/inventoryScan.ts, ./ui.tsx, ./design.tsx,
 *   src/styles/screens/operations.css.
 */
import {
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "@tanstack/react-router";
import {
  Barcode,
  Camera,
  CameraSlash,
  MagnifyingGlass,
  Scan,
} from "@phosphor-icons/react";
import { useWorkspace } from "../data/store";
import { resolveInventoryCode } from "../domain/inventoryScan";
import { Modal, errorText } from "./ui";
import { PageHeader } from "./design";
import "../styles/screens/operations.css";

const SCAN_INTERVAL_MS = 200;
// Frames are scaled down to this width before decoding, which bounds the work
// done every SCAN_INTERVAL_MS.
const MAX_FRAME_WIDTH = 640;

type VideoRef = RefObject<HTMLVideoElement | null>;
type QrDecoder = (typeof import("jsqr"))["default"];

/**
 * The camera QR scanner with a typed-code fallback. A recognized code opens
 * its stock item or component; an unrecognized one shows why, beside the
 * camera or under the typed code it came from. The camera stops after the
 * first code it reads, whether or not that code opens an item.
 *
 * @param props.onOpened - Called just before navigating to an opened item.
 */
export function InventoryScanner({ onOpened }: { onOpened?: () => void }) {
  const openCode = useCodeOpener(onOpened);
  const [typedIssue, setTypedIssue] = useState("");
  const camera = useCameraScan(openCode);
  return (
    <div className="inventory-scanner ops-scan">
      <CameraPreview {...camera} />
      <ManualCodeForm
        issue={typedIssue}
        onCode={(code) => setTypedIssue(openCode(code))}
      />
    </div>
  );
}

/** A Scan button that opens the scanner in a dialog, closed once an item opens. */
export function ScanButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="button" onClick={() => setOpen(true)}>
        <Scan size={18} aria-hidden="true" /> Scan
      </button>
      {open &&
        createPortal(
          <Modal title="Scan inventory label" onClose={() => setOpen(false)}>
            <InventoryScanner onOpened={() => setOpen(false)} />
          </Modal>,
          document.body,
        )}
    </>
  );
}

/** The Scan label page: the scanner under its page header. */
export function ScanPage() {
  return (
    <div className="ops-page">
      <PageHeader
        eyebrow="INVENTORY"
        title="Scan label"
        description="Scan a printed inventory label or enter its code to open the part or component."
      />
      <InventoryScanner />
    </div>
  );
}

// Opens the item a code names; returns why it could not, or "" once opened.
function useCodeOpener(onOpened?: () => void) {
  const s = useWorkspace((state) => state.snapshot);
  const navigate = useNavigate();
  return (raw: string) => {
    try {
      const target = resolveInventoryCode(s!, raw);
      onOpened?.();
      void navigate(
        target.kind === "stock"
          ? { to: "/inventory", search: { item: target.uuid } }
          : { to: "/components", search: { item: target.uuid } },
      );
      return "";
    } catch (error) {
      // resolveInventoryCode refuses a code that matches no item, or several.
      return errorText(error, "This code was not recognized.");
    }
  };
}

function useCameraScan(openCode: (raw: string) => string) {
  const video = useRef<HTMLVideoElement>(null);
  const [cameraIssue, setCameraIssue] = useState("");
  const [scanIssue, setScanIssue] = useState("");
  const [scanning, setScanning] = useState(true);
  // Presentation only: true once the camera feed is playing in the preview.
  const [live, setLive] = useState(false);
  // The camera loop outlives renders; it reads the latest resolver via a ref.
  const open = useRef(openCode);
  useEffect(() => {
    open.current = openCode;
  });
  useEffect(() => {
    if (!scanning) return;
    const session: ScanSession = { stopped: false };
    const stop = () => {
      session.stopped = true;
      window.clearInterval(session.timer);
      session.stream?.getTracks().forEach((track) => track.stop());
      setLive(false);
    };
    void startCamera(session, video, {
      stop,
      setLive,
      setCameraIssue,
      onCode: (code) => {
        stop();
        setScanning(false);
        setScanIssue(open.current(code));
      },
    });
    return stop;
  }, [scanning]);
  const scanAgain = () => {
    setScanIssue("");
    setScanning(true);
  };
  return { video, cameraIssue, scanIssue, scanning, live, scanAgain };
}

// One camera start: the effect's cleanup or the first code read stops it.
interface ScanSession {
  stopped: boolean;
  stream?: MediaStream;
  timer?: number;
}

interface CameraCallbacks {
  stop: () => void;
  setLive: (live: boolean) => void;
  setCameraIssue: (issue: string) => void;
  onCode: (code: string) => void;
}

async function startCamera(
  session: ScanSession,
  video: VideoRef,
  on: CameraCallbacks,
) {
  if (!navigator.mediaDevices?.getUserMedia) {
    on.setCameraIssue(
      "Camera scanning is not available in this browser. Enter the code manually.",
    );
    return;
  }
  try {
    const [media, { default: jsQR }] = await Promise.all([
      navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment" },
        audio: false,
      }),
      import("jsqr"),
    ]);
    session.stream = media;
    if (session.stopped || !video.current) return on.stop();
    video.current.srcObject = media;
    await video.current.play();
    // Closing while play() was pending already ran stop(), so a timer started
    // now would never be cleared.
    if (session.stopped) return;
    on.setLive(true);
    const readCode = createFrameReader(video, jsQR);
    session.timer = window.setInterval(() => {
      const code = readCode();
      if (code) on.onCode(code);
    }, SCAN_INTERVAL_MS);
  } catch (error) {
    if (!session.stopped) on.setCameraIssue(describeCameraError(error));
    on.stop();
  }
}

// Decodes the QR code in the video's current frame, if the frame is ready.
function createFrameReader(video: VideoRef, jsQR: QrDecoder) {
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d", { willReadFrequently: true });
  return () => {
    const v = video.current;
    if (!v || !context || v.readyState < v.HAVE_ENOUGH_DATA) return undefined;
    const scale = Math.min(1, MAX_FRAME_WIDTH / v.videoWidth);
    canvas.width = Math.round(v.videoWidth * scale);
    canvas.height = Math.round(v.videoHeight * scale);
    context.drawImage(v, 0, 0, canvas.width, canvas.height);
    const frame = context.getImageData(0, 0, canvas.width, canvas.height);
    return jsQR(frame.data, frame.width, frame.height, {
      inversionAttempts: "dontInvert",
    })?.data;
  };
}

function describeCameraError(error: unknown) {
  const name = error instanceof DOMException ? error.name : "";
  if (name === "NotAllowedError" || name === "SecurityError")
    return "Camera access was denied. Allow camera access for this site in your browser settings, or enter the code manually.";
  if (name === "NotFoundError" || name === "OverconstrainedError")
    return "No camera was found on this device. Enter the code manually.";
  return "The camera could not be started. Enter the code manually.";
}

type CameraScan = ReturnType<typeof useCameraScan>;

function CameraPreview({
  video,
  cameraIssue,
  scanIssue,
  scanning,
  live,
  scanAgain,
}: CameraScan) {
  return (
    <div className="ops-camera" data-state={cameraState(cameraIssue, live)}>
      {!cameraIssue && scanning && (
        <video
          ref={video}
          className="ops-camera-video"
          playsInline
          muted
          aria-label="Camera preview for scanning inventory labels"
        />
      )}
      <span className="ops-viewfinder" aria-hidden="true" />
      <div className="ops-camera-message">
        <CameraMessage
          cameraIssue={cameraIssue}
          scanIssue={scanIssue}
          scanning={scanning}
        />
        {!cameraIssue && !scanning && (
          <button type="button" className="button" onClick={scanAgain}>
            <Camera size={18} aria-hidden="true" /> Scan again
          </button>
        )}
      </div>
    </div>
  );
}

function cameraState(cameraIssue: string, live: boolean) {
  if (cameraIssue) return "issue";
  return live ? "live" : "idle";
}

function CameraMessage({
  cameraIssue,
  scanIssue,
  scanning,
}: Pick<CameraScan, "cameraIssue" | "scanIssue" | "scanning">) {
  if (cameraIssue)
    return (
      <>
        <CameraSlash size={32} weight="duotone" aria-hidden="true" />
        <strong>Camera unavailable</strong>
        <p role="alert">{cameraIssue}</p>
      </>
    );
  if (scanIssue)
    return (
      <>
        <Camera size={32} weight="duotone" aria-hidden="true" />
        <strong>Label not opened</strong>
        <p role="alert">{scanIssue}</p>
      </>
    );
  if (!scanning)
    return (
      <>
        <Camera size={32} weight="duotone" aria-hidden="true" />
        <strong>Camera stopped</strong>
        <p>Enter the code to open another item.</p>
      </>
    );
  return (
    <>
      <Camera size={32} weight="duotone" aria-hidden="true" />
      <strong>Camera preview</strong>
      <p>Point the camera at an inventory label’s QR code.</p>
    </>
  );
}

function ManualCodeForm({
  issue,
  onCode,
}: {
  issue: string;
  onCode: (code: string) => void;
}) {
  const [code, setCode] = useState("");
  const titleId = useId();
  const hintId = useId();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    onCode(code);
  };
  return (
    <form className="ops-manual" onSubmit={submit} aria-labelledby={titleId}>
      <h2 id={titleId}>Enter a label manually</h2>
      <p id={hintId}>Label link, serial number or part number.</p>
      <CodeInput hintId={hintId} value={code} onChange={setCode} />
      {issue && (
        <p role="alert" className="error">
          {issue}
        </p>
      )}
      <button type="submit" className="button primary">
        <MagnifyingGlass size={18} weight="bold" aria-hidden="true" /> Open item
      </button>
    </form>
  );
}

function CodeInput({
  hintId,
  value,
  onChange,
}: {
  hintId: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="ops-code-field">
      <Barcode size={20} aria-hidden="true" />
      <input
        aria-label="Enter code manually"
        aria-describedby={hintId}
        placeholder="Serial, part number or label link"
        value={value}
        autoComplete="off"
        spellCheck={false}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}
