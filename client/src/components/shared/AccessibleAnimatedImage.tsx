import { useCallback, useEffect, useRef, useState } from "react";
import { useAccessibilityStore } from "../../stores/accessibilityStore";

type AccessibleAnimatedImageProps = {
  src: string;
  alt: string;
  className?: string;
  animated: boolean;
  loading?: "eager" | "lazy";
  decoding?: "async" | "auto" | "sync";
  onError?: React.ReactEventHandler<HTMLImageElement>;
};

/**
 * Browser image elements cannot pause an animated GIF. When autoplay is off,
 * keep the decoded image visually hidden and paint its first frame onto a
 * canvas. Pointer hover or keyboard focus deliberately reveals the animation.
 */
export default function AccessibleAnimatedImage({
  src,
  alt,
  className,
  animated,
  loading = "lazy",
  decoding = "async",
  onError,
}: Readonly<AccessibleAnimatedImageProps>) {
  const autoplayGifs = useAccessibilityStore((state) => state.autoplayGifs);
  const showImageDescriptions = useAccessibilityStore((state) => state.showImageDescriptions);
  const [intentToPlay, setIntentToPlay] = useState(false);
  const [posterReady, setPosterReady] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const shouldGate = animated && !autoplayGifs;
  const playing = !shouldGate || intentToPlay;

  useEffect(() => {
    setPosterReady(false);
    setIntentToPlay(false);
  }, [src, shouldGate]);

  const capturePoster = useCallback((event: React.SyntheticEvent<HTMLImageElement>) => {
    if (!shouldGate) return;
    const image = event.currentTarget;
    const canvas = canvasRef.current;
    if (!canvas || image.naturalWidth <= 0 || image.naturalHeight <= 0) return;
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext("2d");
    if (!context) return;
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    setPosterReady(true);
  }, [shouldGate]);

  return (
    <span
      className="accessible-animated-image"
      onMouseEnter={shouldGate ? () => setIntentToPlay(true) : undefined}
      onMouseLeave={shouldGate ? () => setIntentToPlay(false) : undefined}
      onFocus={shouldGate ? () => setIntentToPlay(true) : undefined}
      onBlur={shouldGate ? () => setIntentToPlay(false) : undefined}
    >
      <img
        src={src}
        alt={playing ? alt : ""}
        aria-hidden={playing ? undefined : true}
        className={className}
        loading={loading}
        decoding={decoding}
        onLoad={capturePoster}
        onError={onError}
        style={playing || !posterReady ? undefined : { display: "none" }}
      />
      {shouldGate && (
        <canvas
          ref={canvasRef}
          className={className}
          role={playing ? undefined : "img"}
          aria-label={playing ? undefined : alt}
          aria-hidden={playing ? true : undefined}
          style={playing || !posterReady ? { display: "none" } : undefined}
        />
      )}
      {showImageDescriptions && <span className="accessible-image-description">{alt}</span>}
    </span>
  );
}
