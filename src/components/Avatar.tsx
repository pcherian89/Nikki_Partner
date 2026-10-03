import { useState } from "react";

/**
 * Nikki's portrait. The image lives at /public/nikki/nikki-avatar.png and can be
 * replaced with a new file of the same name (square PNG, ideally 512×512).
 * If the image can't load, a styled monogram is shown instead — never a broken image.
 */
export const AVATAR_SRC = "/nikki/nikki-avatar.png";

export function Avatar({ size = 40, className = "", glow = false }: { size?: number; className?: string; glow?: boolean }) {
  const [failed, setFailed] = useState(false);
  return (
    <span className={`avatar ${glow ? "glow" : ""} ${className}`} style={{ width: size, height: size }} aria-hidden={size < 48}>
      {failed ? (
        <span className="avatar-fallback" style={{ fontSize: size * 0.42 }}>
          N
        </span>
      ) : (
        <img src={AVATAR_SRC} alt="Nikki" width={size} height={size} onError={() => setFailed(true)} draggable={false} />
      )}
    </span>
  );
}
