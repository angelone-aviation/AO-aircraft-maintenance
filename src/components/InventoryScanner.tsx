/**
 * Responsibility: The inventory scanner: reads a QR code with the camera, or
 *   a typed code, and opens the matching stock item or component.
 * Layer: UI. React component; codes resolve through src/domain.
 * Dependencies: react, react-dom, @tanstack/react-router,
 *   @phosphor-icons/react, src/data/store.ts, src/domain/inventoryScan.ts,
 *   ./ui, ./design, src/styles/screens/operations.css.
 */
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
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
const MAX_FRAME_WIDTH = 640;
function cameraError(error: unknown) {
  const name = error instanceof DOMException ? error.name : "";
  if (name === "NotAllowedError" || name === "SecurityError")
    return "Camera access was denied. Allow camera access for this site in your browser settings, or enter the code manually.";
  if (name === "NotFoundError" || name === "OverconstrainedError")
    return "No camera was found on this device. Enter the code manually.";
  return "The camera could not be started. Enter the code manually.";
}
/** Camera QR scanner with a typed-code fallback; opens the matching item. */
export function InventoryScanner({ onOpened }: { onOpened?: () => void }) {
  const s = useWorkspace((state) => state.snapshot);
  const navigate = useNavigate();
  const video = useRef<HTMLVideoElement>(null);
  const [cameraIssue, setCameraIssue] = useState("");
  const [issue, setIssue] = useState("");
  const [code, setCode] = useState("");
  const [scanning, setScanning] = useState(true);
  // Presentation only: true once the camera feed is playing in the preview.
  const [live, setLive] = useState(false);
  const titleId = useId();
  const hintId = useId();
  const openCode = (raw: string) => {
    try {
      const target = resolveInventoryCode(s!, raw);
      setIssue("");
      onOpened?.();
      void navigate(
        target.kind === "stock"
          ? { to: "/inventory", search: { item: target.uuid } }
          : { to: "/components", search: { item: target.uuid } },
      );
      return true;
    } catch (error) {
      setIssue(errorText(error, "This code was not recognized."));
      return false;
    }
  };
  // The camera loop outlives renders; it reads the latest resolver via a ref.
  const open = useRef(openCode);
  useEffect(() => {
    open.current = openCode;
  });
  useEffect(() => {
    if (!scanning) return;
    let stream: MediaStream | undefined;
    let timer: number | undefined;
    let stopped = false;
    let lastCode = "";
    const stop = () => {
      stopped = true;
      window.clearInterval(timer);
      stream?.getTracks().forEach((track) => track.stop());
      setLive(false);
    };
    (async () => {
      if (!navigator.mediaDevices?.getUserMedia) {
        setCameraIssue(
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
        stream = media;
        if (stopped || !video.current) return stop();
        video.current.srcObject = media;
        await video.current.play();
        if (!stopped) setLive(true);
        const canvas = document.createElement("canvas");
        const context = canvas.getContext("2d", { willReadFrequently: true });
        timer = window.setInterval(() => {
          const v = video.current;
          if (!v || !context || v.readyState < v.HAVE_ENOUGH_DATA) return;
          const scale = Math.min(1, MAX_FRAME_WIDTH / v.videoWidth);
          canvas.width = Math.round(v.videoWidth * scale);
          canvas.height = Math.round(v.videoHeight * scale);
          context.drawImage(v, 0, 0, canvas.width, canvas.height);
          const frame = context.getImageData(0, 0, canvas.width, canvas.height);
          const found = jsQR(frame.data, frame.width, frame.height, {
            inversionAttempts: "dontInvert",
          });
          if (!found?.data || found.data === lastCode) return;
          lastCode = found.data;
          if (open.current(found.data)) {
            stop();
            setScanning(false);
          }
        }, SCAN_INTERVAL_MS);
      } catch (error) {
        if (!stopped) setCameraIssue(cameraError(error));
        stop();
      }
    })();
    return stop;
  }, [scanning]);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    openCode(code);
  };
  return (
    <div className="inventory-scanner ops-scan">
      <div
        className="ops-camera"
        data-state={cameraIssue ? "issue" : live ? "live" : "idle"}
      >
        <span className="ops-camera-grid" aria-hidden="true" />
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
          {cameraIssue ? (
            <>
              <CameraSlash size={32} weight="duotone" aria-hidden="true" />
              <strong>Camera unavailable</strong>
              <p role="alert">{cameraIssue}</p>
            </>
          ) : scanning ? (
            <>
              <Camera size={32} weight="duotone" aria-hidden="true" />
              <strong>Camera preview</strong>
              <p>Point the camera at an inventory label’s QR code.</p>
            </>
          ) : (
            <>
              <Camera size={32} weight="duotone" aria-hidden="true" />
              <strong>Camera stopped</strong>
              <p>Enter the code to open another item.</p>
            </>
          )}
        </div>
      </div>
      <form className="ops-manual" onSubmit={submit} aria-labelledby={titleId}>
        <h2 id={titleId}>Enter a label manually</h2>
        <p id={hintId}>Label link, serial number or part number.</p>
        <label className="ops-code-field">
          <Barcode size={20} aria-hidden="true" />
          <input
            aria-label="Enter code manually"
            aria-describedby={hintId}
            placeholder="Serial, part number or label link"
            value={code}
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => setCode(e.target.value)}
          />
        </label>
        {issue && (
          <p role="alert" className="error">
            {issue}
          </p>
        )}
        <button type="submit" className="button primary">
          <MagnifyingGlass size={18} weight="bold" aria-hidden="true" /> Open
          item
        </button>
      </form>
    </div>
  );
}
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
